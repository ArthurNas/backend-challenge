import { ApplicationError } from './application-error';
import { WagerCommand } from './process-wager-transaction';
import { Money } from '../domain/money';
import { WagerTransactionKind } from '../domain/wager-transaction';

export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ApplicationError('INVALID_PAYLOAD', 400);
  }

  return value as Record<string, unknown>;
}

export function text(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 255 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ApplicationError(`INVALID_${field}`, 400);
  }

  return value;
}

export function uuid(value: unknown, field: string): string {
  const parsed = text(value, field);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed)) {
    throw new ApplicationError(`INVALID_${field}`, 400);
  }

  return parsed.toLowerCase();
}

export function money(value: unknown): Money {
  const parsed = object(value);

  return Money.from({
    amount: text(parsed.amount, 'AMOUNT'),
    currency: text(parsed.currency, 'CURRENCY'),
  });
}

export function wagerCommand(body: unknown, key: unknown): WagerCommand {
  const parsed = object(body);
  const kind = text(parsed.kind, 'KIND');
  if (!Object.values(WagerTransactionKind).includes(kind as WagerTransactionKind)) {
    throw new ApplicationError('INVALID_KIND', 400);
  }

  const command: WagerCommand = {
    providerId: text(parsed.providerId, 'PROVIDER_ID'),
    externalTransactionId: text(parsed.externalTransactionId, 'EXTERNAL_TRANSACTION_ID'),
    idempotencyKey: text(key, 'IDEMPOTENCY_KEY'),
    walletId: uuid(parsed.walletId, 'WALLET_ID'),
    playerId: uuid(parsed.playerId, 'PLAYER_ID'),
    roundId: text(parsed.roundId, 'ROUND_ID'),
    gameId: text(parsed.gameId, 'GAME_ID'),
    kind: kind as WagerTransactionKind,
    money: money(parsed.money),
  };
  if (parsed.referenceExternalTransactionId !== undefined) {
    command.referenceExternalTransactionId = text(
      parsed.referenceExternalTransactionId,
      'REFERENCE_ID',
    );
  }

  return command;
}

export function pageLimit(value: unknown): number {
  if (value === undefined) return 50;

  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value))
    throw new ApplicationError('INVALID_LIMIT', 400);

  const parsed = Number(value);
  if (parsed < 1 || parsed > 100) throw new ApplicationError('INVALID_LIMIT', 400);

  return parsed;
}
