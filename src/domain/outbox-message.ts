import { IntegrationEvent } from './events/integration-event';
import { immutableSnapshot } from './immutable-snapshot';

export interface OutboxState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    private readonly _occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<object>): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.toJSON(),
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxState): OutboxMessage {
    return new OutboxMessage(
      state.id,
      state.aggregateId,
      state.eventType,
      immutableSnapshot(state.payload),
      new Date(state.occurredAt),
      state.attempts,
      state.nextAttemptAt && new Date(state.nextAttemptAt),
      state.publishedAt && new Date(state.publishedAt),
    );
  }

  get occurredAt(): Date {
    return new Date(this._occurredAt);
  }

  get attempts(): number {
    return this._attempts;
  }

  get nextAttemptAt(): Date | undefined {
    if (!this._nextAttemptAt) return undefined;

    return new Date(this._nextAttemptAt);
  }

  get publishedAt(): Date | undefined {
    if (!this._publishedAt) return undefined;

    return new Date(this._publishedAt);
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    if (!this.isPending()) return false;

    if (!this._nextAttemptAt) return true;

    return this._nextAttemptAt <= now;
  }

  markPublished(at: Date): void {
    if (!this.isPending()) return;

    this._publishedAt = new Date(at);
  }

  scheduleRetry(now: Date): void {
    if (!this.isPending()) return;

    this._attempts += 1;

    const delay = Math.min(1000 * 2 ** Math.min(this._attempts - 1, 9), 300_000);

    this._nextAttemptAt = new Date(now.getTime() + delay);
  }
}
