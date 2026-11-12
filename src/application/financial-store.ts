import { MoneyProps } from '../domain/money';
import { Wallet } from '../domain/wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../domain/wager-transaction';
import { FailureCode } from '../domain/domain-error';
import { WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { IntegrationEvent } from '../domain/events/integration-event';
import { EventContext } from '../domain/events/integration-event';

export interface InboxDelivery {
  messageId: string;
  consumerName: string;
  payloadHash: string;
}

export interface PendingReferenceState {
  due: boolean;
  expired: boolean;
  correlationId: string;
  causationId?: string;
}

export interface TransactionIdentity {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
}

export interface TransactionResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  failureCode?: FailureCode;
}

export interface TransactionSnapshot {
  transaction: WagerTransaction;
  result: TransactionResult;
}

export interface FinancialUnitOfWork {
  lockWallet(walletId: string): Promise<Wallet>;
  saveWallet(wallet: Wallet): Promise<void>;
  findExisting(identity: TransactionIdentity): Promise<TransactionSnapshot[]>;
  findReference(providerId: string, externalId: string): Promise<WagerTransaction | undefined>;
  wasReversed(referenceId: string, kind: WagerTransactionKind): Promise<boolean>;
  saveTransaction(
    transaction: WagerTransaction,
    result: TransactionResult,
    context?: EventContext,
  ): Promise<void>;
  findTransaction(transactionId: string): Promise<TransactionSnapshot | undefined>;
  receiveInbox(delivery: InboxDelivery): Promise<void>;
  completeInbox(delivery: InboxDelivery): Promise<void>;
  pendingReference(transactionId: string): Promise<PendingReferenceState | undefined>;
  retryReference(transactionId: string): Promise<void>;
  finishReference(transactionId: string): Promise<void>;
  appendLedger(entry: WalletLedgerEntry, version: number): Promise<void>;
  enqueue(event: IntegrationEvent<object>): Promise<void>;
}

export abstract class FinancialStore {
  abstract transaction<T>(work: (unit: FinancialUnitOfWork) => Promise<T>): Promise<T>;
}
