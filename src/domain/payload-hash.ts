import { createHash } from 'node:crypto';
import type { CreateWagerTransactionProps } from './wager-transaction';

export function hashBusinessPayload(props: CreateWagerTransactionProps): string {
  // Allowlist explícita: IDs internos, chave e metadados de transporte não entram.
  const business: Record<string, unknown> = {
    providerId: props.providerId,
    externalTransactionId: props.externalTransactionId,
    playerId: props.playerId,
    walletId: props.walletId,
    roundId: props.roundId,
    gameId: props.gameId,
    kind: props.kind,
    money: props.money.toJSON(),
  };
  if (props.referenceExternalTransactionId !== undefined) {
    business.referenceExternalTransactionId = props.referenceExternalTransactionId;
  }

  return createHash('sha256').update(canonicalJSON(business), 'utf8').digest('hex');
}

function canonicalJSON(value: unknown): string {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;

    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJSON(object[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
