import { Migration } from '@mikro-orm/migrations';

export class Migration202611110002 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions drop constraint wager_transactions_wallet_id_player_id_currency_fkey;
      alter table wager_transactions add constraint transaction_wallet_exists
        foreign key (wallet_id) references wallets(id);
      alter table wallets add constraint wallet_currency_identity unique (id, currency);
      alter table wallet_ledger_entries add constraint ledger_wallet_currency
        foreign key (wallet_id, currency) references wallets(id, currency);

      create function assert_processed_wallet_identity() returns trigger language plpgsql as $$
      declare
        current_transaction wager_transactions%rowtype;
      begin
        select * into current_transaction from wager_transactions where id = new.id;
        if current_transaction.status <> 'PROCESSED' then return null; end if;
        if not exists (
          select 1 from wallets where id = current_transaction.wallet_id
            and player_id = current_transaction.player_id and currency = current_transaction.currency
        ) then
          raise exception 'Processed transaction must match wallet identity' using errcode = '23514';
        end if;
        return null;
      end;
      $$;

      create constraint trigger processed_wallet_identity after insert or update on wager_transactions
        deferrable initially deferred for each row execute function assert_processed_wallet_identity();

      create table outbox_messages (
        id uuid primary key,
        aggregate_id uuid not null,
        event_type text not null,
        payload jsonb not null,
        occurred_at timestamptz not null,
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz,
        published_at timestamptz,
        check (jsonb_typeof(payload) = 'object'),
        check (payload->>'eventId' is not null and payload->>'eventType' is not null
          and payload->>'aggregateId' is not null and payload->>'correlationId' is not null
          and payload->>'occurredAt' is not null and payload->>'version' is not null
          and payload->'data' is not null),
        check (payload->>'eventId' = id::text),
        check (payload->>'eventType' = event_type),
        check (payload->>'aggregateId' = aggregate_id::text)
      );
      create index due_outbox on outbox_messages(next_attempt_at, occurred_at, id)
        where published_at is null;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table outbox_messages;
      drop trigger processed_wallet_identity on wager_transactions;
      drop function assert_processed_wallet_identity();
      alter table wallet_ledger_entries drop constraint ledger_wallet_currency;
      alter table wallets drop constraint wallet_currency_identity;
      alter table wager_transactions drop constraint transaction_wallet_exists;
      alter table wager_transactions add constraint wager_transactions_wallet_id_player_id_currency_fkey
        foreign key (wallet_id, player_id, currency) references wallets(id, player_id, currency) not valid;
    `);
  }
}
