import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection } from '../../src/domain/wallet-ledger-entry';

export interface RawMovement {
  wallet: Wallet;
  kind: string;
  direction: LedgerDirection;
  amount?: string;
  currency?: string;
  providerId?: string;
  playerId?: string;
  roundId?: string;
  referenceId?: string;
  referenceExternalId?: string;
}

// SQL direto para testar as constraints sem passar pelas validações do caso de uso.
export async function rawFinancialWrite(orm: MikroORM, input: RawMovement): Promise<string> {
  const id = randomUUID();
  await orm.em.fork().transactional(async (em) => {
    const rows = await em.execute<{ balance: string; version: number; currency: string }[]>(
      'select balance::text, version, currency from wallets where id = ? for update',
      [input.wallet.id],
    );
    const row = rows[0]!;
    const before = Money.from({ amount: row.balance, currency: row.currency });
    const amount = input.amount ?? '25.00';
    const movement = Money.from({ amount, currency: row.currency });
    const after =
      input.direction === LedgerDirection.Credit ? before.add(movement) : before.subtract(movement);
    const version = row.version + 1;
    const currency = input.currency ?? row.currency;

    await em.execute(
      `
      insert into wager_transactions(id, provider_id, external_transaction_id, idempotency_key,
        payload_hash, wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
        reference_external_transaction_id, reference_transaction_id, created_at, processed_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PROCESSED', ?, ?, now(), now())
    `,
      [
        id,
        input.providerId ?? 'provider-a',
        id,
        `schema:${id}`,
        'd'.repeat(64),
        input.wallet.id,
        input.playerId ?? input.wallet.playerId,
        input.roundId ?? 'round',
        'game',
        input.kind,
        amount,
        currency,
        input.referenceExternalId ?? null,
        input.referenceId ?? null,
      ],
    );

    await em.execute(
      `
      insert into wallet_ledger_entries(id, wallet_id, transaction_id, direction, amount, currency,
        balance_before, balance_after, wallet_version, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
    `,
      [
        randomUUID(),
        input.wallet.id,
        id,
        input.direction,
        amount,
        currency,
        before.toString(),
        after.toString(),
        version,
      ],
    );
    await em.execute(
      'update wallets set balance = ?, version = ?, updated_at = now() where id = ?',
      [after.toString(), version, input.wallet.id],
    );
  });
  return id;
}
