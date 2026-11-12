import { randomUUID } from 'node:crypto';
import { WagerTransaction } from '../wager-transaction';
import { MoneyProps } from '../money';
import { FailureCode } from '../domain-error';
import { EventContext, IntegrationEvent, IntegrationEventProps } from './integration-event';

interface WagerEventData {
  transactionId: string;
  walletId: string;
  providerId: string;
  externalTransactionId: string;
  kind: string;
  status: string;
  money: MoneyProps;
  failureCode?: FailureCode;
}

function eventProps(
  transaction: WagerTransaction,
  context: EventContext,
): IntegrationEventProps<WagerEventData> {
  const data: WagerEventData = {
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    kind: transaction.kind,
    status: transaction.status,
    money: transaction.money.toJSON(),
  };
  if (transaction.failureCode) data.failureCode = transaction.failureCode;

  return {
    ...context,
    eventId: randomUUID(),
    aggregateId: transaction.walletId,
    occurredAt: new Date(),
    data,
  };
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionProcessed';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed(eventProps(transaction, context));
  }
}

export class WagerTransactionRejected extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionRejected';
  readonly version = 1;

  static from(transaction: WagerTransaction, context: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected(eventProps(transaction, context));
  }
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerEventData> {
  readonly eventType = 'WagerTransactionPendingReference';
  readonly version = 1;

  static from(
    transaction: WagerTransaction,
    context: EventContext,
  ): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference(eventProps(transaction, context));
  }
}
