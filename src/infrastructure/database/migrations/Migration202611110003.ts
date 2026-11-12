import { Migration } from '@mikro-orm/migrations';

export class Migration202611110003 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table inbox_messages (
        consumer_name text not null,
        message_id text not null,
        payload_hash varchar(64) not null check (payload_hash ~ '^[a-f0-9]{64}$'),
        received_at timestamptz not null default now(),
        processed_at timestamptz,
        primary key (consumer_name, message_id)
      );

      alter table outbox_messages add column claim_token uuid;
      alter table outbox_messages add column lease_until timestamptz;

      create table pending_references (
        transaction_id uuid primary key references wager_transactions(id),
        attempts integer not null default 0 check (attempts >= 0),
        next_attempt_at timestamptz not null default (now() + interval '1 second'),
        expires_at timestamptz not null default (now() + interval '24 hours'),
        correlation_id text not null,
        causation_id text
      );
      create index due_pending_references on pending_references(next_attempt_at, transaction_id);

      insert into pending_references(transaction_id, correlation_id, expires_at)
        select id, id::text, created_at + interval '24 hours' from wager_transactions
        where status = 'PENDING_REFERENCE';
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`
      drop table pending_references;
      drop table inbox_messages;
      alter table outbox_messages drop column lease_until;
      alter table outbox_messages drop column claim_token;
    `);
  }
}
