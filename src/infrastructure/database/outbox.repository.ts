import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { OutboxMessage } from '../../domain/outbox-message';

interface ClaimedRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
  attempts: number;
  next_attempt_at: Date | null;
}

export interface OutboxClaim {
  message: OutboxMessage;
  token: string;
}

export class OutboxRepository {
  constructor(
    private readonly orm: MikroORM,
    private readonly leaseSeconds = 120,
  ) {}

  async claim(): Promise<OutboxClaim | undefined> {
    const token = randomUUID();
    const rows = await this.orm.em.execute<ClaimedRow[]>(
      `
      with due as (
        select id from outbox_messages where published_at is null
          and (next_attempt_at is null or next_attempt_at <= now())
          and (lease_until is null or lease_until <= now())
        order by occurred_at, id for update skip locked limit 1
      )
      update outbox_messages set claim_token = ?, lease_until = now() + ? * interval '1 second'
      from due where outbox_messages.id = due.id returning outbox_messages.*
    `,
      [token, this.leaseSeconds],
    );
    const row = rows[0];
    if (!row) return undefined;

    const message = OutboxMessage.rehydrate({
      id: row.id,
      aggregateId: row.aggregate_id,
      eventType: row.event_type,
      payload: row.payload,
      occurredAt: row.occurred_at,
      attempts: row.attempts,
      ...(row.next_attempt_at ? { nextAttemptAt: row.next_attempt_at } : {}),
    });

    return { message, token };
  }

  async published(claim: OutboxClaim): Promise<void> {
    await this.orm.em.execute(
      `update outbox_messages set published_at = now(), claim_token = null, lease_until = null
      where id = ? and claim_token = ? and published_at is null`,
      [claim.message.id, claim.token],
    );
    claim.message.markPublished(new Date());
  }

  async retry(claim: OutboxClaim): Promise<void> {
    if (!claim.message.isPending()) return;

    const now = new Date();

    claim.message.scheduleRetry(now);

    const delayMilliseconds = claim.message.nextAttemptAt!.getTime() - now.getTime();

    await this.orm.em.execute(
      `update outbox_messages set attempts = ?, next_attempt_at = now() + ? * interval '1 millisecond',
      claim_token = null, lease_until = null where id = ? and claim_token = ? and published_at is null`,
      [claim.message.attempts, delayMilliseconds, claim.message.id, claim.token],
    );
  }

  async lagSeconds(): Promise<number> {
    const rows = await this.orm.em.execute<{ lag: number }[]>(`select coalesce(
      extract(epoch from now() - min(occurred_at)), 0)::float8 as lag
      from outbox_messages where published_at is null`);

    return Math.max(rows[0]?.lag ?? 0, 0);
  }
}
