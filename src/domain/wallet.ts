import { DomainError } from './domain-error';
import { Money } from './money';
import { LedgerDirection, WalletLedgerEntry } from './wallet-ledger-entry';

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Movement {
  entryId: string;
  transactionId: string;
  money: Money;
  at: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: { id: string; playerId: string; initialBalance: Money; at: Date }): Wallet {
    if (props.initialBalance.isNegative()) throw new DomainError('INVALID_AMOUNT');

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(props.at),
      new Date(props.at),
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get updatedAt(): Date {
    return new Date(this._updatedAt);
  }

  debit(props: Movement, reversal = false): WalletLedgerEntry {
    return this.move(props, LedgerDirection.Debit, reversal);
  }

  credit(props: Movement): WalletLedgerEntry {
    return this.move(props, LedgerDirection.Credit);
  }

  private move(props: Movement, direction: LedgerDirection, reversal = false): WalletLedgerEntry {
    this.assertSameCurrency(props.money);
    if (!props.money.isPositive()) throw new DomainError('INVALID_AMOUNT');

    if (direction === LedgerDirection.Debit && this.balance.isLessThan(props.money)) {
      throw new DomainError(reversal ? 'REVERSAL_INSUFFICIENT_FUNDS' : 'INSUFFICIENT_FUNDS');
    }

    const after =
      direction === LedgerDirection.Credit
        ? this.balance.add(props.money)
        : this.balance.subtract(props.money);
    const entry = WalletLedgerEntry.create({
      id: props.entryId,
      transactionId: props.transactionId,
      walletId: this.id,
      direction,
      money: props.money,
      balanceBefore: this.balance,
      balanceAfter: after,
      createdAt: props.at,
    });

    this._balance = after;
    this._version += 1;
    this._updatedAt = new Date(props.at);

    return entry;
  }

  private assertSameCurrency(money: Money): void {
    if (money.currency !== this.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
}
