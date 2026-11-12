import { Migration } from '@mikro-orm/migrations';

export class Migration202611110004 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      alter table wager_transactions add constraint reference_ids_agree
        check (reference_transaction_id is null or reference_external_transaction_id is not null);

      create function protect_wallet_identity() returns trigger language plpgsql as $$
      begin
        if (new.id, new.player_id, new.currency, new.created_at)
          is distinct from (old.id, old.player_id, old.currency, old.created_at) then
          raise exception 'Wallet identity is immutable' using errcode = '23514';
        end if;
        return new;
      end;
      $$;
      create trigger immutable_wallet_identity before update on wallets
        for each row execute function protect_wallet_identity();

      create function protect_outbox_content() returns trigger language plpgsql as $$
      begin
        if (new.id, new.aggregate_id, new.event_type, new.payload, new.occurred_at)
          is distinct from (old.id, old.aggregate_id, old.event_type, old.payload, old.occurred_at) then
          raise exception 'Outbox event content is immutable' using errcode = '23514';
        end if;
        if old.published_at is not null and new.published_at is distinct from old.published_at then
          raise exception 'Published outbox event cannot become pending again' using errcode = '23514';
        end if;
        return new;
      end;
      $$;
      create trigger immutable_outbox_content before update on outbox_messages
        for each row execute function protect_outbox_content();

      create function reject_outbox_deletion() returns trigger language plpgsql as $$
      begin
        raise exception 'Outbox audit events cannot be deleted' using errcode = '23514';
      end;
      $$;
      create trigger immutable_outbox_history before delete or truncate on outbox_messages
        for each statement execute function reject_outbox_deletion();

      create function protect_transaction_progress() returns trigger language plpgsql as $$
      begin
        if old.status = 'PENDING_REFERENCE' and new.status = 'PENDING' then
          raise exception 'Pending reference cannot return to initial state' using errcode = '23514';
        end if;
        return new;
      end;
      $$;
      create trigger transaction_progress before update on wager_transactions
        for each row execute function protect_transaction_progress();
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop trigger transaction_progress on wager_transactions;
      drop function protect_transaction_progress();
      drop trigger immutable_outbox_history on outbox_messages;
      drop function reject_outbox_deletion();
      drop trigger immutable_outbox_content on outbox_messages;
      drop function protect_outbox_content();
      drop trigger immutable_wallet_identity on wallets;
      drop function protect_wallet_identity();
      alter table wager_transactions drop constraint reference_ids_agree;
    `);
  }
}
