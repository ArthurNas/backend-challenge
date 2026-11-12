import { createHash } from 'node:crypto';
import { ApplicationError } from '../../application/application-error';
import { wagerCommand, object, text } from '../../application/input-validation';

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;

  if (typeof value !== 'object' || value === null) return JSON.stringify(value);

  const fields = value as Record<string, unknown>;

  return `{${Object.keys(fields)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJSON(fields[key])}`)
    .join(',')}}`;
}

export function parseWagerMessage(body: string) {
  let envelope: Record<string, unknown>;

  try {
    envelope = object(JSON.parse(body));
  } catch {
    throw new ApplicationError('INVALID_MESSAGE_JSON', 400);
  }

  if (envelope.type !== 'WagerTransactionRequested')
    throw new ApplicationError('INVALID_MESSAGE_TYPE', 400);

  const messageId = text(envelope.messageId, 'MESSAGE_ID');
  const occurredAt = text(envelope.occurredAt, 'OCCURRED_AT');
  if (!/^\d{4}-\d\d-\d\dT/.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))) {
    throw new ApplicationError('INVALID_OCCURRED_AT', 400);
  }

  const data = object(envelope.data);
  const command = wagerCommand(data, data.idempotencyKey);
  const correlationId =
    envelope.correlationId === undefined
      ? messageId
      : text(envelope.correlationId, 'CORRELATION_ID');

  return {
    command,
    context: { correlationId, causationId: messageId },
    delivery: {
      messageId,
      consumerName: 'wager-transactions',
      payloadHash: createHash('sha256').update(canonicalJSON(envelope)).digest('hex'),
    },
  };
}
