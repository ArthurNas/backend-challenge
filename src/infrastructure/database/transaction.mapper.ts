import { TransactionResult, TransactionSnapshot } from '../../application/financial-store';
import { FailureCode } from '../../domain/domain-error';
import { Money } from '../../domain/money';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionState,
  WagerTransactionStatus,
} from '../../domain/wager-transaction';
import { TransactionRecord } from './entities';

export class TransactionMapper {
  static toDomain(record: TransactionRecord): WagerTransaction {
    const state: WagerTransactionState = {
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: Money.from({ amount: record.amount, currency: record.currency }),
      status: record.status as WagerTransactionStatus,
      createdAt: record.createdAt,
    };
    if (record.referenceExternalTransactionId)
      state.referenceExternalTransactionId = record.referenceExternalTransactionId;

    if (record.referenceTransactionId) state.referenceTransactionId = record.referenceTransactionId;

    if (record.failureCode) state.failureCode = record.failureCode as FailureCode;

    if (record.processedAt) state.processedAt = record.processedAt;

    return WagerTransaction.rehydrate(state);
  }

  static toRecord(transaction: WagerTransaction, result: TransactionResult): TransactionRecord {
    const record = new TransactionRecord();

    record.id = transaction.id;
    record.providerId = transaction.providerId;
    record.externalTransactionId = transaction.externalTransactionId;
    record.idempotencyKey = transaction.idempotencyKey;
    record.payloadHash = transaction.payloadHash;
    record.walletId = transaction.walletId;
    record.playerId = transaction.playerId;
    record.roundId = transaction.roundId;
    record.gameId = transaction.gameId;
    record.kind = transaction.kind;
    record.amount = transaction.money.toString();
    record.currency = transaction.money.currency;
    record.status = transaction.status;
    record.createdAt = transaction.createdAt;
    record.result = { ...result };
    if (transaction.referenceExternalTransactionId)
      record.referenceExternalTransactionId = transaction.referenceExternalTransactionId;

    if (transaction.referenceTransactionId)
      record.referenceTransactionId = transaction.referenceTransactionId;

    if (transaction.failureCode) record.failureCode = transaction.failureCode;

    if (transaction.processedAt) record.processedAt = transaction.processedAt;

    return record;
  }

  static toSnapshot(record: TransactionRecord): TransactionSnapshot {
    if (!record.result) throw new Error('Persisted transaction result is missing');

    return {
      transaction: TransactionMapper.toDomain(record),
      result: record.result as unknown as TransactionResult,
    };
  }
}
