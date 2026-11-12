import { IsolationLevel } from '@mikro-orm/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { ConsoleLogger } from '@nestjs/common';
import { ApplicationError } from '../../application/application-error';
import { Money } from '../../domain/money';
import { FinancialMetrics } from '../observability/financial-metrics';
import { LedgerRecord, TransactionRecord, WalletRecord } from './entities';

export class FinancialQueries {
  private readonly logger = new ConsoleLogger('Reconciliation', { json: true });

  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: FinancialMetrics,
  ) {}

  async wallet(walletId: string) {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    if (!record) throw new ApplicationError('WALLET_NOT_FOUND', 404);

    return {
      id: record.id,
      playerId: record.playerId,
      balance: { amount: record.balance, currency: record.currency },
      version: record.version,
    };
  }

  async transaction(transactionId: string) {
    const record = await this.orm.em.fork().findOne(TransactionRecord, { id: transactionId });

    return this.transactionView(record);
  }

  async providerTransaction(providerId: string, externalTransactionId: string) {
    const record = await this.orm.em
      .fork()
      .findOne(TransactionRecord, { providerId, externalTransactionId });

    return this.transactionView(record);
  }

  async ledger(walletId: string, cursor: string | undefined, limit: number) {
    await this.wallet(walletId);

    const version = this.decodeCursor(cursor, walletId);
    const records = await this.orm.em.fork().find(
      LedgerRecord,
      {
        walletId,
        walletVersion: { $gt: version },
      },
      { orderBy: { walletVersion: 'asc' }, limit: limit + 1 },
    );
    const page = records.slice(0, limit);
    const nextCursor = this.nextCursor(records, page, walletId, limit);

    return {
      items: page.map((record) => this.ledgerView(record)),
      nextCursor,
    };
  }

  async reconcile(walletId: string, correlationId: string) {
    const result = await this.orm.em.fork().transactional(
      async (em) => {
        const wallet = await em.findOne(WalletRecord, { id: walletId });
        if (!wallet) throw new ApplicationError('WALLET_NOT_FOUND', 404);

        const rows = await em.execute<{ balance: string; count: string }[]>(
          `
        select coalesce(sum(case direction when 'CREDIT' then amount else -amount end), 0.00)::text as balance,
          count(*)::text as count from wallet_ledger_entries where wallet_id = ?
      `,
          [walletId],
        );
        const summary = rows[0]!;
        const stored = Money.from({ amount: wallet.balance, currency: wallet.currency });
        const calculated = this.signedMoney(summary.balance, wallet.currency);

        return {
          walletId,
          storedBalance: stored.toJSON(),
          calculatedBalance: calculated.toJSON(),
          difference: stored.subtract(calculated).toJSON(),
          consistent: stored.equals(calculated),
          checkedEntries: Number(summary.count),
        };
      },
      { isolationLevel: IsolationLevel.REPEATABLE_READ },
    );

    if (!result.consistent) {
      this.metrics.increment('wagering_reconciliation_mismatches_total');
      this.logger.error({ code: 'RECONCILIATION_MISMATCH', walletId, correlationId });
    }

    return result;
  }

  private signedMoney(amount: string, currency: string): Money {
    if (!amount.startsWith('-')) return Money.from({ amount, currency });

    return Money.from({ amount: amount.slice(1), currency }).negate();
  }

  private transactionView(record: TransactionRecord | null) {
    if (!record) throw new ApplicationError('TRANSACTION_NOT_FOUND', 404);

    return {
      ...record.result,
      transactionId: record.id,
      status: record.status,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind,
      money: { amount: record.amount, currency: record.currency },
      referenceExternalTransactionId: record.referenceExternalTransactionId,
      referenceTransactionId: record.referenceTransactionId,
      failureCode: record.failureCode,
      createdAt: record.createdAt.toISOString(),
      processedAt: record.processedAt?.toISOString(),
    };
  }

  private ledgerView(record: LedgerRecord) {
    return {
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction,
      money: { amount: record.amount, currency: record.currency },
      balanceBefore: { amount: record.balanceBefore, currency: record.currency },
      balanceAfter: { amount: record.balanceAfter, currency: record.currency },
      createdAt: record.createdAt.toISOString(),
      walletVersion: record.walletVersion,
    };
  }

  private nextCursor(
    records: LedgerRecord[],
    page: LedgerRecord[],
    walletId: string,
    limit: number,
  ): string | null {
    if (records.length <= limit) return null;

    return Buffer.from(JSON.stringify({ walletId, version: page.at(-1)!.walletVersion })).toString(
      'base64url',
    );
  }

  private decodeCursor(cursor: string | undefined, walletId: string): number {
    if (cursor === undefined) return 0;

    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error('Invalid encoding');

      const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null) throw new Error('Invalid cursor');

      if (!('walletId' in parsed) || parsed.walletId !== walletId) throw new Error('Wrong wallet');

      if (
        !('version' in parsed) ||
        !Number.isSafeInteger(parsed.version) ||
        Number(parsed.version) < 1
      ) {
        throw new Error('Invalid version');
      }

      return parsed.version as number;
    } catch {
      throw new ApplicationError('INVALID_CURSOR', 400);
    }
  }
}
