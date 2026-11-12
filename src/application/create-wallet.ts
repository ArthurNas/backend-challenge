import { randomUUID } from 'node:crypto';
import { EventContext } from '../domain/events/integration-event';
import { WagerTransactionProcessed } from '../domain/events/wager-events';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed';
import { Money } from '../domain/money';
import { hashBusinessPayload } from '../domain/payload-hash';
import { Wallet } from '../domain/wallet';
import { LedgerDirection, WalletLedgerEntry } from '../domain/wallet-ledger-entry';
import { WagerTransaction, WagerTransactionKind } from '../domain/wager-transaction';
import { FinancialStore, FinancialUnitOfWork } from './financial-store';

export class CreateWallet {
  constructor(private readonly store: FinancialStore) {}

  async execute(playerId: string, initialBalance: Money, context: EventContext): Promise<Wallet> {
    const wallet = Wallet.open({ id: randomUUID(), playerId, initialBalance, at: new Date() });

    await this.store.transaction((unit) => this.persist(unit, wallet, context));

    return wallet;
  }

  private async persist(
    unit: FinancialUnitOfWork,
    wallet: Wallet,
    context: EventContext,
  ): Promise<void> {
    await unit.saveWallet(wallet);
    if (wallet.balance.isZero()) return;

    const transaction = this.openingTransaction(wallet);
    const entry = WalletLedgerEntry.create({
      id: randomUUID(),
      walletId: wallet.id,
      transactionId: transaction.id,
      direction: LedgerDirection.Credit,
      money: wallet.balance,
      balanceBefore: Money.zero(wallet.currency),
      balanceAfter: wallet.balance,
      createdAt: wallet.createdAt,
    });

    await unit.saveTransaction(transaction, {
      transactionId: transaction.id,
      status: transaction.status,
      balance: wallet.balance.toJSON(),
    });
    await unit.appendLedger(entry, wallet.version);
    await unit.enqueue(WagerTransactionProcessed.from(transaction, context));
    await unit.enqueue(WalletBalanceChanged.from(wallet, entry, context));
  }

  private openingTransaction(wallet: Wallet): WagerTransaction {
    const props = {
      id: randomUUID(),
      providerId: '__internal__',
      externalTransactionId: wallet.id,
      idempotencyKey: `opening:${wallet.id}`,
      payloadHash: '',
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: `opening:${wallet.id}`,
      gameId: '__internal__',
      kind: WagerTransactionKind.Opening,
      money: wallet.balance,
      createdAt: wallet.createdAt,
    };
    const transaction = WagerTransaction.opening({
      ...props,
      payloadHash: hashBusinessPayload(props),
    });

    transaction.markProcessed(undefined, wallet.createdAt);

    return transaction;
  }
}
