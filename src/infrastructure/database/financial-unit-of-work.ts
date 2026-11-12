import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { ApplicationError } from '../../application/application-error';
import {
  FinancialUnitOfWork,
  TransactionIdentity,
  TransactionResult,
  TransactionSnapshot,
  InboxDelivery,
  PendingReferenceState,
} from '../../application/financial-store';
import { IntegrationEvent } from '../../domain/events/integration-event';
import { EventContext } from '../../domain/events/integration-event';
import { DomainError } from '../../domain/domain-error';
import { InboxMessage } from '../../domain/inbox-message';
import { OutboxMessage } from '../../domain/outbox-message';
import { Wallet } from '../../domain/wallet';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind } from '../../domain/wager-transaction';
import { LedgerRecord, OutboxRecord, TransactionRecord, WalletRecord } from './entities';
import { TransactionMapper } from './transaction.mapper';
import { WalletMapper } from './wallet.mapper';

export class PostgresFinancialUnitOfWork implements FinancialUnitOfWork {
  constructor(private readonly em: EntityManager) {}

  async lockWallet(walletId: string): Promise<Wallet> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      {
        lockMode: LockMode.PESSIMISTIC_WRITE,
      },
    );
    if (!record) throw new ApplicationError('WALLET_NOT_FOUND', 404);

    return WalletMapper.toDomain(record);
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const record = await this.em.findOne(WalletRecord, { id: wallet.id });
    if (!record) {
      await this.em.persistAndFlush(WalletMapper.toRecord(wallet));

      return;
    }

    this.em.assign(record, WalletMapper.toRecord(wallet));
    await this.em.flush();
  }

  async findExisting(identity: TransactionIdentity): Promise<TransactionSnapshot[]> {
    const records = await this.em.find(
      TransactionRecord,
      {
        $or: [
          { idempotencyKey: identity.idempotencyKey },
          {
            providerId: identity.providerId,
            externalTransactionId: identity.externalTransactionId,
          },
        ],
      },
      { limit: 2, refresh: true },
    );

    return records.map((record) => TransactionMapper.toSnapshot(record));
  }

  async findReference(
    providerId: string,
    externalId: string,
  ): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(TransactionRecord, {
      providerId,
      externalTransactionId: externalId,
    });
    if (!record) return undefined;

    return TransactionMapper.toDomain(record);
  }

  async wasReversed(referenceId: string, kind: WagerTransactionKind): Promise<boolean> {
    return this.em
      .count(TransactionRecord, {
        referenceTransactionId: referenceId,
        kind,
        status: 'PROCESSED',
      })
      .then((count) => count > 0);
  }

  async saveTransaction(
    transaction: WagerTransaction,
    result: TransactionResult,
    context?: EventContext,
  ): Promise<void> {
    const record = TransactionMapper.toRecord(transaction, result);
    const existing = await this.em.findOne(TransactionRecord, { id: transaction.id });
    if (existing) {
      this.em.assign(existing, record);
      await this.em.flush();

      return;
    }

    await this.em.persistAndFlush(record);
    if (transaction.status !== 'PENDING_REFERENCE') return;

    await this.em.execute(
      `
      insert into pending_references(transaction_id, correlation_id, causation_id)
      values (?, ?, ?) on conflict do nothing
    `,
      [transaction.id, context?.correlationId ?? transaction.id, context?.causationId ?? null],
    );
  }

  async findTransaction(transactionId: string): Promise<TransactionSnapshot | undefined> {
    const record = await this.em.findOne(
      TransactionRecord,
      { id: transactionId },
      { refresh: true },
    );
    if (!record) return undefined;

    return TransactionMapper.toSnapshot(record);
  }

  async receiveInbox(delivery: InboxDelivery): Promise<void> {
    await this.em.execute(
      `
      insert into inbox_messages(consumer_name, message_id, payload_hash) values (?, ?, ?)
      on conflict do nothing
    `,
      [delivery.consumerName, delivery.messageId, delivery.payloadHash],
    );

    const rows = await this.em.execute<{ payload_hash: string }[]>(
      `
      select payload_hash from inbox_messages where consumer_name = ? and message_id = ? for update
    `,
      [delivery.consumerName, delivery.messageId],
    );
    if (rows[0]?.payload_hash !== delivery.payloadHash)
      throw new DomainError('INBOX_PAYLOAD_CONFLICT');
  }

  async completeInbox(delivery: InboxDelivery): Promise<void> {
    const message = InboxMessage.receive({ ...delivery, receivedAt: new Date() });

    message.markProcessed(new Date());
    await this.em.execute(
      `
      update inbox_messages set processed_at = coalesce(processed_at, ?)
      where consumer_name = ? and message_id = ?
    `,
      [message.processedAt, delivery.consumerName, delivery.messageId],
    );
  }

  async pendingReference(transactionId: string): Promise<PendingReferenceState | undefined> {
    const rows = await this.em.execute<
      {
        due: boolean;
        expired: boolean;
        correlation_id: string;
        causation_id: string | null;
      }[]
    >(
      `select next_attempt_at <= now() as due, expires_at <= now() as expired,
      correlation_id, causation_id from pending_references where transaction_id = ?`,
      [transactionId],
    );
    const row = rows[0];
    if (!row) return undefined;

    const state: PendingReferenceState = {
      due: row.due,
      expired: row.expired,
      correlationId: row.correlation_id,
    };
    if (row.causation_id) state.causationId = row.causation_id;

    return state;
  }

  async retryReference(transactionId: string): Promise<void> {
    await this.em.execute(
      `update pending_references set attempts = attempts + 1,
      next_attempt_at = now() + least(power(2, least(attempts + 1, 9)), 300) * interval '1 second'
      where transaction_id = ?`,
      [transactionId],
    );
  }

  async finishReference(transactionId: string): Promise<void> {
    await this.em.execute('delete from pending_references where transaction_id = ?', [
      transactionId,
    ]);
  }

  async appendLedger(entry: WalletLedgerEntry, version: number): Promise<void> {
    const record = this.em.create(LedgerRecord, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      walletVersion: version,
      createdAt: entry.createdAt,
    });

    await this.em.persistAndFlush(record);
  }

  async enqueue(event: IntegrationEvent<object>): Promise<void> {
    const message = OutboxMessage.enqueue(event);
    const record = this.em.create(OutboxRecord, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
    });

    await this.em.persistAndFlush(record);
  }
}
