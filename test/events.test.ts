import { describe, expect, test } from 'bun:test';
import { OutboxMessage } from '../src/domain/outbox-message';
import { IntegrationEvent } from '../src/domain/events/integration-event';
import { InboxMessage } from '../src/domain/inbox-message';

class TestEvent extends IntegrationEvent<{ money: { amount: string; currency: string } }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;
  static create() {
    return new TestEvent({
      eventId: 'event',
      aggregateId: 'wallet',
      correlationId: 'request',
      occurredAt: new Date('2026-01-01T00:00:00Z'),
      data: { money: { amount: '25.00', currency: 'BRL' } },
    });
  }
}

describe('Eventos e outbox', () => {
  test('inbox mantém a primeira conclusão e protege suas datas', () => {
    const receivedAt = new Date('2026-01-01T00:00:00Z');
    const message = InboxMessage.receive({
      messageId: 'message',
      consumerName: 'consumer',
      payloadHash: 'hash',
      receivedAt,
    });
    receivedAt.setFullYear(2000);
    expect(message.receivedAt.getUTCFullYear()).toBe(2026);
    expect(message.isProcessed()).toBe(false);
    message.markProcessed(new Date('2026-01-01T00:01:00Z'));
    message.markProcessed(new Date('2026-01-01T00:02:00Z'));
    expect(message.processedAt?.toISOString()).toBe('2026-01-01T00:01:00.000Z');
    message.processedAt?.setFullYear(2000);
    expect(message.processedAt?.getUTCFullYear()).toBe(2026);
    expect(message.isProcessed()).toBe(true);
  });
  test('envelope é JSON estável com dinheiro em string e data ISO', () => {
    const event = TestEvent.create();
    expect(event.toJSON()).toEqual({
      eventId: 'event',
      aggregateId: 'wallet',
      correlationId: 'request',
      eventType: 'TestEvent',
      version: 1,
      occurredAt: '2026-01-01T00:00:00.000Z',
      data: { money: { amount: '25.00', currency: 'BRL' } },
    });
    event.toJSON().data.money.amount = '0.00';
    expect(event.toJSON().data.money.amount).toBe('25.00');
    expect(Object.isFrozen(event.data.money)).toBe(true);
    const message = OutboxMessage.enqueue(event);
    expect(Object.isFrozen(message.payload.data)).toBe(true);
  });

  test('retry aplica backoff limitado e mensagem publicada não volta a pendente', () => {
    const outbox = OutboxMessage.enqueue(TestEvent.create());
    const now = new Date('2026-01-01T00:00:00Z');
    expect(outbox.isDue(now)).toBe(true);
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(new Date(now.getTime() + 999))).toBe(false);
    expect(outbox.isDue(new Date(now.getTime() + 1000))).toBe(true);
    for (let attempt = 0; attempt < 20; attempt += 1) outbox.scheduleRetry(now);
    expect(outbox.nextAttemptAt?.getTime()).toBe(now.getTime() + 300000);
    outbox.markPublished(now);
    const attempts = outbox.attempts;
    outbox.scheduleRetry(now);
    expect(outbox.attempts).toBe(attempts);
    expect(outbox.isPending()).toBe(false);
    expect(outbox.isDue(new Date('2027-01-01'))).toBe(false);
  });
});
