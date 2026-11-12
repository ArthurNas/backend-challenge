import { randomUUID } from 'node:crypto';
import { DomainError, FailureCode } from '../domain/domain-error';
import { EventContext } from '../domain/events/integration-event';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
} from '../domain/events/wager-events';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { hashBusinessPayload } from '../domain/payload-hash';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import {
  CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import {
  FinancialStore,
  FinancialUnitOfWork,
  TransactionResult,
  InboxDelivery,
} from './financial-store';
import { ProviderIdentityPort } from './provider-identity.port';
import { FinancialTelemetry } from './financial-telemetry.port';

export type WagerCommand = Omit<CreateWagerTransactionProps, 'id' | 'payloadHash'>;

export type WagerResponse = TransactionResult & { idempotentReplay: boolean };

interface ReprocessedOutcome {
  transaction: WagerTransaction;
  result: WagerResponse;
  context: EventContext;
}

const businessRejections = new Set<FailureCode>([
  'INSUFFICIENT_FUNDS',
  'REVERSAL_INSUFFICIENT_FUNDS',
  'CURRENCY_MISMATCH',
  'WALLET_PLAYER_MISMATCH',
  'REFERENCE_MISMATCH',
  'INVALID_REFERENCE_KIND',
  'REFERENCE_NOT_PROCESSED',
  'INVALID_AMOUNT',
  'ALREADY_REVERSED',
  'MONEY_OUT_OF_RANGE',
]);

export class ProcessWagerTransaction {
  constructor(
    private readonly store: FinancialStore,
    private readonly identity: ProviderIdentityPort,
    private readonly telemetry: FinancialTelemetry,
  ) {}

  async execute(
    command: WagerCommand,
    context: EventContext,
    delivery?: InboxDelivery,
  ): Promise<WagerResponse> {
    const startedAt = performance.now();

    await this.identity.assertProvider(command.providerId);

    const props = this.createProps(command);

    WagerTransaction.create({ ...props, createdAt: new Date() });

    const result = await this.store.transaction(async (unit) => {
      if (delivery) await unit.receiveInbox(delivery);

      const response = await this.process(unit, props, context);

      if (delivery) await unit.completeInbox(delivery);

      return response;
    });

    this.telemetry.completed(command, result, context, performance.now() - startedAt);

    return result;
  }

  async reprocess(transactionId: string): Promise<void> {
    const startedAt = performance.now();
    const outcome = await this.store.transaction((unit) => this.retryPending(unit, transactionId));
    if (!outcome) return;

    this.telemetry.completed(
      outcome.transaction,
      outcome.result,
      outcome.context,
      performance.now() - startedAt,
    );
  }

  private async retryPending(
    unit: FinancialUnitOfWork,
    transactionId: string,
  ): Promise<ReprocessedOutcome | undefined> {
    const initial = await unit.findTransaction(transactionId);
    if (!initial || initial.transaction.isTerminal()) return;

    const wallet = await unit.lockWallet(initial.transaction.walletId);
    const current = await unit.findTransaction(transactionId);
    if (!current || current.transaction.isTerminal()) return;

    const pending = await unit.pendingReference(transactionId);
    if (!pending?.due) return;

    const transaction = current.transaction;
    let entry: WalletLedgerEntry | undefined;

    if (pending.expired) transaction.reject('REFERENCE_NOT_FOUND_EXPIRED');
    else entry = await this.apply(unit, wallet, transaction);

    if (!transaction.isTerminal()) {
      await unit.retryReference(transactionId);

      return;
    }

    const result = await this.persistOutcome(unit, wallet, transaction, entry, pending);

    await unit.finishReference(transactionId);

    return { transaction, result: { ...result, idempotentReplay: false }, context: pending };
  }

  private createProps(command: WagerCommand): CreateWagerTransactionProps {
    const props = { ...command, id: randomUUID(), payloadHash: '' };

    return { ...props, payloadHash: hashBusinessPayload(props) };
  }

  private async process(
    unit: FinancialUnitOfWork,
    props: CreateWagerTransactionProps,
    context: EventContext,
  ): Promise<WagerResponse> {
    const replay = await this.findReplay(unit, props);
    if (replay) return replay;

    const wallet = await unit.lockWallet(props.walletId);

    // Outra conexão pode ter concluído a mesma operação enquanto aguardávamos o lock.
    const replayAfterLock = await this.findReplay(unit, props);
    if (replayAfterLock) return replayAfterLock;

    const transaction = WagerTransaction.create({ ...props, createdAt: new Date() });
    const entry = await this.apply(unit, wallet, transaction);
    const result = await this.persistOutcome(unit, wallet, transaction, entry, context);

    return { ...result, idempotentReplay: false };
  }

  private async persistOutcome(
    unit: FinancialUnitOfWork,
    wallet: Wallet,
    transaction: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    context: EventContext,
  ): Promise<TransactionResult> {
    const result = this.resultFor(transaction, wallet);

    await unit.saveWallet(wallet);
    await unit.saveTransaction(transaction, result, context);
    if (entry) await unit.appendLedger(entry, wallet.version);

    await this.enqueueEvents(unit, wallet, transaction, entry, context);

    return result;
  }

  private async findReplay(
    unit: FinancialUnitOfWork,
    props: CreateWagerTransactionProps,
  ): Promise<WagerResponse | undefined> {
    const matches = await unit.findExisting(props);
    if (matches.length === 0) return undefined;

    if (matches.length > 1) throw new DomainError('IDEMPOTENCY_CONFLICT');

    const existing = matches[0]!;
    if (existing.transaction.idempotencyKey !== props.idempotencyKey) {
      throw new DomainError('IDEMPOTENCY_CONFLICT');
    }

    existing.transaction.assertReplay(props.payloadHash);

    return { ...existing.result, idempotentReplay: true };
  }

  private async apply(
    unit: FinancialUnitOfWork,
    wallet: Wallet,
    transaction: WagerTransaction,
  ): Promise<WalletLedgerEntry | undefined> {
    try {
      this.assertWalletIdentity(wallet, transaction);

      const reference = await this.resolveReference(unit, transaction);
      if (transaction.referenceExternalTransactionId !== undefined && !reference) return undefined;

      const entry = this.moveBalance(wallet, transaction, reference);

      transaction.markProcessed(reference?.id, new Date());

      return entry;
    } catch (error) {
      if (!(error instanceof DomainError) || !businessRejections.has(error.code)) throw error;

      transaction.reject(error.code);

      return undefined;
    }
  }

  private assertWalletIdentity(wallet: Wallet, transaction: WagerTransaction): void {
    if (wallet.playerId !== transaction.playerId) throw new DomainError('WALLET_PLAYER_MISMATCH');

    if (wallet.currency !== transaction.money.currency) throw new DomainError('CURRENCY_MISMATCH');
  }

  private async resolveReference(
    unit: FinancialUnitOfWork,
    transaction: WagerTransaction,
  ): Promise<WagerTransaction | undefined> {
    if (transaction.referenceExternalTransactionId === undefined) return undefined;

    const reference = await unit.findReference(
      transaction.providerId,
      transaction.referenceExternalTransactionId,
    );
    if (!reference) {
      transaction.markPendingReference();

      return undefined;
    }

    const reversed = await unit.wasReversed(reference.id, transaction.kind);

    try {
      transaction.validateReference(reference, reversed);
    } catch (error) {
      const awaitingProcessing =
        error instanceof DomainError && error.code === 'REFERENCE_NOT_PROCESSED';
      if (!awaitingProcessing || reference.isTerminal()) throw error;

      transaction.markPendingReference();

      return undefined;
    }

    return reference;
  }

  private moveBalance(
    wallet: Wallet,
    transaction: WagerTransaction,
    reference?: WagerTransaction,
  ): WalletLedgerEntry | undefined {
    const direction = transaction.ledgerDirectionFor(reference);
    if (!direction) return undefined;

    const movement = {
      entryId: randomUUID(),
      transactionId: transaction.id,
      money: transaction.money,
      at: new Date(),
    };
    if (direction === LedgerDirection.Credit) return wallet.credit(movement);

    return wallet.debit(movement, transaction.requiresReference());
  }

  private resultFor(transaction: WagerTransaction, wallet: Wallet): TransactionResult {
    const result: TransactionResult = {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
    };
    if (transaction.failureCode) result.failureCode = transaction.failureCode;

    return result;
  }

  private async enqueueEvents(
    unit: FinancialUnitOfWork,
    wallet: Wallet,
    transaction: WagerTransaction,
    entry: WalletLedgerEntry | undefined,
    context: EventContext,
  ): Promise<void> {
    if (transaction.status === WagerTransactionStatus.PendingReference) {
      await unit.enqueue(WagerTransactionPendingReference.from(transaction, context));

      return;
    }

    if (transaction.status === WagerTransactionStatus.Rejected) {
      await unit.enqueue(WagerTransactionRejected.from(transaction, context));

      return;
    }

    await unit.enqueue(WagerTransactionProcessed.from(transaction, context));
    if (entry) await unit.enqueue(WalletBalanceChanged.from(wallet, entry, context));
  }
}
