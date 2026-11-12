import Decimal from 'decimal.js';
import { DomainError } from './domain-error';

export interface MoneyProps {
  amount: string;
  currency: string;
}

// NUMERIC(20,2): 18 dígitos inteiros. Precisão extra evita arredondar somas
// antes de validar overflow. Configuração isolada das demais bibliotecas.
const ExactDecimal = Decimal.clone({ precision: 40 });

const MAX = new ExactDecimal('999999999999999999.99');

const currencies = new Set(Intl.supportedValuesOf('currency'));

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {
    if (value.abs().greaterThan(MAX)) throw new DomainError('MONEY_OUT_OF_RANGE');

    Object.freeze(this);
  }

  static from(props: MoneyProps): Money {
    if (typeof props.amount !== 'string' || !/^(0|[1-9]\d{0,17})\.\d{2}$/.test(props.amount)) {
      throw new DomainError('INVALID_MONEY');
    }

    if (!currencies.has(props.currency)) throw new DomainError('INVALID_CURRENCY');

    return new Money(new ExactDecimal(props.amount), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);

    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.greaterThan(0);
  }

  isNegative(): boolean {
    return this.value.lessThan(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);

    return this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.value.toFixed(2), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(2);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new DomainError('CURRENCY_MISMATCH');
  }
}
