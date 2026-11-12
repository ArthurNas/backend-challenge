import { Migration } from '@mikro-orm/migrations';

export class Migration202611110001 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table wallets (
        id uuid primary key,
        player_id uuid not null,
        currency varchar(3) not null check (currency ~ '^[A-Z]{3}$'),
        balance numeric(20,2) not null check (balance between 0 and 999999999999999999.99),
        version integer not null check (version >= 1),
        created_at timestamptz not null,
        updated_at timestamptz not null,
        unique (player_id, currency),
        unique (id, player_id, currency)
      );

      create table wager_transactions (
        id uuid primary key,
        provider_id text not null,
        external_transaction_id text not null,
        idempotency_key text not null unique,
        payload_hash varchar(64) not null check (payload_hash ~ '^[a-f0-9]{64}$'),
        wallet_id uuid not null,
        player_id uuid not null,
        round_id text not null,
        game_id text not null,
        kind text not null check (kind in ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount numeric(20,2) not null,
        currency varchar(3) not null,
        status text not null check (status in ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        reference_external_transaction_id text,
        reference_transaction_id uuid references wager_transactions(id),
        failure_code text,
        result jsonb,
        created_at timestamptz not null,
        processed_at timestamptz,
        unique (provider_id, external_transaction_id),
        unique (id, wallet_id, currency),
        foreign key (wallet_id, player_id, currency) references wallets(id, player_id, currency),
        check (amount between 0 and 999999999999999999.99),
        check ((kind = 'LOSS' and amount = 0) or (kind <> 'LOSS' and amount > 0)),
        check (kind not in ('REFUND','ROLLBACK') or reference_external_transaction_id is not null),
        check (kind not in ('BET','LOSS','OPENING') or reference_external_transaction_id is null),
        check (status <> 'PENDING_REFERENCE' or reference_external_transaction_id is not null),
        check ((status = 'PROCESSED') = (processed_at is not null)),
        check ((status in ('REJECTED','FAILED')) = (failure_code is not null)),
        check (status <> 'PROCESSED' or reference_external_transaction_id is null or reference_transaction_id is not null)
      );

      create unique index one_processed_reversal_per_kind
        on wager_transactions(reference_transaction_id, kind)
        where status = 'PROCESSED' and kind in ('REFUND','ROLLBACK');

      create unique index one_opening_per_wallet on wager_transactions(wallet_id)
        where kind = 'OPENING';

      create index pending_reference_lookup on wager_transactions(provider_id, reference_external_transaction_id)
        where status = 'PENDING_REFERENCE';

      create table wallet_ledger_entries (
        id uuid primary key,
        wallet_id uuid not null references wallets(id),
        transaction_id uuid not null,
        direction text not null check (direction in ('DEBIT','CREDIT')),
        amount numeric(20,2) not null check (amount > 0 and amount <= 999999999999999999.99),
        currency varchar(3) not null,
        balance_before numeric(20,2) not null check (balance_before between 0 and 999999999999999999.99),
        balance_after numeric(20,2) not null check (balance_after between 0 and 999999999999999999.99),
        wallet_version integer not null check (wallet_version >= 1),
        created_at timestamptz not null,
        unique (transaction_id, wallet_id),
        unique (wallet_id, wallet_version),
        foreign key (transaction_id, wallet_id, currency) references wager_transactions(id, wallet_id, currency),
        check (balance_after = balance_before + case direction when 'CREDIT' then amount else -amount end)
      );

      create index ledger_cursor on wallet_ledger_entries(wallet_id, created_at, id);
    `);

    this.addIntegrityFunctions();
    this.addIntegrityTriggers();
  }

  private addIntegrityFunctions(): void {
    this.addSql(`
      create function reject_ledger_mutation() returns trigger language plpgsql as $$
      begin
        raise exception 'Ledger entries are immutable' using errcode = '23514';
      end;
      $$;

      create function lock_ledger_wallet() returns trigger language plpgsql as $$
      begin
        perform id from wallets where id = new.wallet_id for update;
        return new;
      end;
      $$;

      create function protect_transaction() returns trigger language plpgsql as $$
      begin
        if tg_op = 'DELETE' then
          raise exception 'Transaction audit records are immutable and cannot be deleted' using errcode = '23514';
        end if;
        if old.status in ('PROCESSED','REJECTED','FAILED') then
          raise exception 'Terminal transactions are immutable' using errcode = '23514';
        end if;
        if (to_jsonb(old) - array['status','reference_transaction_id','failure_code','processed_at','result'])
          is distinct from
          (to_jsonb(new) - array['status','reference_transaction_id','failure_code','processed_at','result']) then
          raise exception 'Transaction business fields are immutable' using errcode = '23514';
        end if;
        return new;
      end;
      $$;

      create function assert_wallet_consistency() returns trigger language plpgsql as $$
      declare
        target_wallet uuid;
        stored_balance numeric;
        stored_version integer;
        ledger_balance numeric;
        movements bigint;
        latest_version integer;
      begin
        target_wallet := new.wallet_id;
        select balance, version into stored_balance, stored_version from wallets where id = target_wallet for update;
        select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0),
          count(*) filter (where wallet_version > 1), coalesce(max(wallet_version), 1)
          into ledger_balance, movements, latest_version from wallet_ledger_entries where wallet_id = target_wallet;
        if stored_balance <> ledger_balance or stored_version <> movements + 1 or stored_version <> latest_version then
          raise exception 'Wallet balance/version differs from ledger' using errcode = '23514';
        end if;
        return null;
      end;
      $$;

      create function assert_wallet_row_consistency() returns trigger language plpgsql as $$
      declare
        ledger_balance numeric;
        movements bigint;
        latest_version integer;
        current_wallet wallets%rowtype;
      begin
        select * into current_wallet from wallets where id = new.id;
        select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0),
          count(*) filter (where wallet_version > 1), coalesce(max(wallet_version), 1)
          into ledger_balance, movements, latest_version from wallet_ledger_entries where wallet_id = new.id;
        if current_wallet.balance <> ledger_balance or current_wallet.version <> movements + 1 or current_wallet.version <> latest_version then
          raise exception 'Wallet balance/version differs from ledger' using errcode = '23514';
        end if;
        return null;
      end;
      $$;

      create function assert_transaction_ledger() returns trigger language plpgsql as $$
      declare
        transaction_row wager_transactions%rowtype;
        entry wallet_ledger_entries%rowtype;
        reference_row wager_transactions%rowtype;
        expected_direction text;
      begin
        select * into transaction_row from wager_transactions where id = new.id;
        select * into entry from wallet_ledger_entries where transaction_id = new.id;
        if transaction_row.status <> 'PROCESSED' or transaction_row.kind = 'LOSS' then
          if entry.id is not null then
            raise exception 'Non-financial transaction has ledger entry' using errcode = '23514';
          end if;
          return null;
        end if;
        if entry.id is null or entry.amount <> transaction_row.amount then
          raise exception 'Processed transaction requires matching ledger entry' using errcode = '23514';
        end if;
        expected_direction := 'CREDIT';
        if transaction_row.kind = 'BET' then expected_direction := 'DEBIT'; end if;
        if transaction_row.reference_transaction_id is not null then
          select * into reference_row from wager_transactions where id = transaction_row.reference_transaction_id;
          if reference_row.status <> 'PROCESSED' or
             (reference_row.provider_id, reference_row.wallet_id, reference_row.player_id, reference_row.currency, reference_row.round_id, reference_row.external_transaction_id)
             is distinct from
             (transaction_row.provider_id, transaction_row.wallet_id, transaction_row.player_id, transaction_row.currency, transaction_row.round_id, transaction_row.reference_external_transaction_id) then
            raise exception 'Invalid transaction reference' using errcode = '23514';
          end if;
          if transaction_row.kind in ('REFUND','WIN') and reference_row.kind <> 'BET' then
            raise exception 'Reference must be a BET' using errcode = '23514';
          end if;
          if transaction_row.kind = 'ROLLBACK' and reference_row.kind not in ('BET','WIN','REFUND') then
            raise exception 'Invalid rollback reference kind' using errcode = '23514';
          end if;
          if transaction_row.kind in ('REFUND','ROLLBACK') and reference_row.amount <> transaction_row.amount then
            raise exception 'Partial reversal is unsupported' using errcode = '23514';
          end if;
          if transaction_row.kind = 'ROLLBACK' and reference_row.kind <> 'BET' then expected_direction := 'DEBIT'; end if;
        end if;
        if entry.direction <> expected_direction then
          raise exception 'Ledger direction differs from transaction' using errcode = '23514';
        end if;
        return null;
      end;
      $$;

      create function assert_ledger_transaction() returns trigger language plpgsql as $$
      declare
        transaction_row wager_transactions%rowtype;
        previous_balance numeric;
      begin
        select * into transaction_row from wager_transactions where id = new.transaction_id;
        if transaction_row.status <> 'PROCESSED' or transaction_row.kind = 'LOSS' or transaction_row.amount <> new.amount then
          raise exception 'Ledger requires a processed financial transaction' using errcode = '23514';
        end if;
        select balance_after into previous_balance from wallet_ledger_entries
          where wallet_id = new.wallet_id and wallet_version = new.wallet_version - 1;
        if new.balance_before <> coalesce(previous_balance, 0) then
          raise exception 'Ledger balance chain is broken' using errcode = '23514';
        end if;
        if (transaction_row.kind = 'OPENING') <> (new.wallet_version = 1) then
          raise exception 'Only opening uses wallet version one' using errcode = '23514';
        end if;
        return null;
      end;
      $$;
    `);
  }

  private addIntegrityTriggers(): void {
    this.addSql(`
      create trigger immutable_ledger before update or delete or truncate on wallet_ledger_entries
        for each statement execute function reject_ledger_mutation();
      create trigger serialize_ledger_insert before insert on wallet_ledger_entries
        for each row execute function lock_ledger_wallet();
      create trigger immutable_transaction before update or delete on wager_transactions
        for each row execute function protect_transaction();
      create constraint trigger wallet_row_consistency after insert or update on wallets
        deferrable initially deferred for each row execute function assert_wallet_row_consistency();
      create constraint trigger wallet_ledger_consistency after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function assert_wallet_consistency();
      create constraint trigger transaction_ledger_consistency after insert or update on wager_transactions
        deferrable initially deferred for each row execute function assert_transaction_ledger();
      create constraint trigger ledger_transaction_consistency after insert on wallet_ledger_entries
        deferrable initially deferred for each row execute function assert_ledger_transaction();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table wallet_ledger_entries;
      drop table wager_transactions;
      drop table wallets;
      drop function assert_ledger_transaction();
      drop function assert_transaction_ledger();
      drop function assert_wallet_row_consistency();
      drop function assert_wallet_consistency();
      drop function protect_transaction();
      drop function lock_ledger_wallet();
      drop function reject_ledger_mutation();
    `);
  }
}
