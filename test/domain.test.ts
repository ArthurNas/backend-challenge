import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money';
import { DomainError, type FailureCode } from '../src/domain/domain-error';
import { Wallet } from '../src/domain/wallet';
import { LedgerDirection as Direction, WalletLedgerEntry } from '../src/domain/wallet-ledger-entry';
import {
  WagerTransaction as Transaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
  type CreateWagerTransactionProps,
} from '../src/domain/wager-transaction';
import { hashBusinessPayload } from '../src/domain/payload-hash';

const at = new Date('2026-01-01T00:00:00Z');
const money = (amount: string, currency = 'BRL') => Money.from({ amount, currency });
function expectCode(action: () => unknown, code: FailureCode): void {
  try {
    action();
    throw new Error('Expected DomainError');
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}
function props(
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps & { createdAt: Date } {
  return {
    id: 'bet',
    providerId: 'provider',
    externalTransactionId: 'external-bet',
    idempotencyKey: 'provider:external-bet',
    payloadHash: 'hash',
    walletId: 'wallet',
    playerId: 'player',
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: money('25.00'),
    createdAt: at,
    ...overrides,
  };
}
function processed(kind = Kind.Bet): Transaction {
  const reference = Transaction.create(props({ kind }));
  reference.markProcessed(undefined, at);
  return reference;
}
const wallet = () =>
  Wallet.open({ id: 'wallet', playerId: 'player', initialBalance: money('100.00'), at });
const movement = (amount = '25.00') => ({
  entryId: 'entry',
  transactionId: 'transaction',
  money: money(amount),
  at,
});

describe('Money', () => {
  test.each([
    '',
    'NaN',
    'Infinity',
    '1e2',
    '-1.00',
    '-0.00',
    '1.001',
    '0',
    '0.0',
    '25',
    '25.0',
    ' 1',
    '1 ',
    '+1',
    '.50',
    '1.',
    '01.00',
    '1000000000000000000.00',
  ])('rejeita entrada %j', (amount) => {
    expectCode(() => money(amount), 'INVALID_MONEY');
  });
  test('não aceita number mesmo se o contrato TypeScript for burlado', () => {
    expectCode(() => money(25 as unknown as string), 'INVALID_MONEY');
  });
  test('preserva duas casas na aritmética sem alterar instâncias', () => {
    const first = money('0.10');
    expect(first.add(money('0.20')).toString()).toBe('0.30');
    expect(first.toJSON()).toEqual({ amount: '0.10', currency: 'BRL' });
    expect(Object.isFrozen(first)).toBe(true);
    expect(money('1.00').toString()).toBe('1.00');
  });
  test('mantém centavos além da precisão segura de number', () => {
    expect(money('999999999999999999.98').add(money('0.01')).toString()).toBe(
      '999999999999999999.99',
    );
    expectCode(() => money('999999999999999999.99').add(money('0.01')), 'MONEY_OUT_OF_RANGE');
  });
  test('permite diferenças internas negativas e zero não é positivo', () => {
    const difference = money('1.00').subtract(money('2.00'));
    expect(difference.isNegative()).toBe(true);
    expect(difference.negate().equals(money('1.00'))).toBe(true);
    expect(Money.zero('BRL').isZero()).toBe(true);
    expect(Money.zero('BRL').isPositive()).toBe(false);
    expect(Money.zero('BRL').isNegative()).toBe(false);
  });
  test('rejeita moeda inválida e operações entre moedas diferentes', () => {
    expectCode(() => money('1.00', 'XYZ'), 'INVALID_CURRENCY');
    for (const method of ['add', 'subtract', 'equals', 'isLessThan'] as const) {
      expectCode(() => money('1.00')[method](money('1.00', 'USD')), 'CURRENCY_MISMATCH');
    }
  });
});

describe('Wallet e ledger', () => {
  test('abertura version=1, inclusive com saldo zero', () => {
    expect(wallet().version).toBe(1);
    expect(
      Wallet.open({ id: 'w', playerId: 'p', initialBalance: Money.zero('BRL'), at }).version,
    ).toBe(1);
  });
  test('movimentações geram ledger balanceado e version só muda no sucesso', () => {
    const w = wallet();
    const debit = w.debit(movement('80.00'));
    expect(debit.balanceBefore.toString()).toBe('100.00');
    expect(debit.balanceAfter.toString()).toBe('20.00');
    expect(debit.direction).toBe(Direction.Debit);
    expect(debit.isBalanced()).toBe(true);
    expect(w.version).toBe(2);
    expectCode(() => w.debit(movement('80.00')), 'INSUFFICIENT_FUNDS');
    expect(w.version).toBe(2);
    expect(w.balance.toString()).toBe('20.00');
    w.credit(movement('5.00'));
    expect(w.balance.toString()).toBe('25.00');
    expect(w.version).toBe(3);
  });
  test('rejeita débito de reversão sem saldo com código distinto', () => {
    expectCode(() => wallet().debit(movement('101.00'), true), 'REVERSAL_INSUFFICIENT_FUNDS');
  });
  test('rejeita moeda, zero e negativos sem mudar estado', () => {
    const w = wallet();
    expectCode(() => w.credit({ ...movement(), money: money('1.00', 'USD') }), 'CURRENCY_MISMATCH');
    expectCode(() => w.credit(movement('0.00')), 'INVALID_AMOUNT');
    expectCode(() => w.debit({ ...movement(), money: money('1.00').negate() }), 'INVALID_AMOUNT');
    expect(w.version).toBe(1);
    expect(w.balance.toString()).toBe('100.00');
  });
  test('ledger é congelado, datas são defensivas e aritmética inválida é rejeitada', () => {
    const w = wallet();
    const entry = w.debit(movement());
    expect(Object.isFrozen(entry)).toBe(true);
    entry.createdAt.setFullYear(2000);
    w.createdAt.setFullYear(2000);
    expect(entry.createdAt.toISOString()).toBe(at.toISOString());
    expect(w.createdAt.toISOString()).toBe(at.toISOString());
    expectCode(
      () =>
        WalletLedgerEntry.create({
          id: 'e',
          walletId: 'w',
          transactionId: 't',
          direction: Direction.Debit,
          money: money('1.00'),
          balanceBefore: money('10.00'),
          balanceAfter: money('10.00'),
          createdAt: at,
        }),
      'INVALID_LEDGER',
    );
  });
  test('saldo reconstruído pelos lançamentos corresponde à carteira', () => {
    const w = wallet();
    const entries = [
      w.debit(movement('80.00')),
      w.credit(movement('5.00')),
      w.debit(movement('25.00')),
    ];
    const reconstructed = entries.reduce(
      (balance, entry) =>
        entry.direction === Direction.Credit
          ? balance.add(entry.money)
          : balance.subtract(entry.money),
      money('100.00'),
    );
    expect(w.balance.equals(reconstructed)).toBe(true);
    expect(w.balance.isZero()).toBe(true);
  });
});

describe('WagerTransaction', () => {
  test.each([
    [Kind.Bet, Direction.Debit],
    [Kind.Win, Direction.Credit],
    [Kind.Loss, undefined],
  ] as const)('%s tem o efeito esperado', (kind, direction) => {
    const transaction = Transaction.create(
      props({ kind, money: money(kind === Kind.Loss ? '0.00' : '25.00') }),
    );
    expect(transaction.status).toBe(Status.Pending);
    expect(transaction.ledgerDirectionFor()).toBe(direction);
    expect(transaction.affectsBalance()).toBe(kind !== Kind.Loss);
  });
  test('OPENING só pode ser criado pelo caminho interno', () => {
    expectCode(() => Transaction.create(props({ kind: Kind.Opening })), 'INTERNAL_OPERATION');
    expect(Transaction.opening(props({ kind: Kind.Opening })).ledgerDirectionFor()).toBe(
      Direction.Credit,
    );
  });
  test.each([Kind.Refund, Kind.Rollback])('%s exige referência', (kind) => {
    expectCode(() => Transaction.create(props({ kind })), 'REFERENCE_REQUIRED');
  });
  test.each([Kind.Bet, Kind.Win, Kind.Refund, Kind.Rollback])('%s rejeita valor zero', (kind) => {
    expectCode(
      () =>
        Transaction.create(
          props({
            kind,
            money: money('0.00'),
            ...(kind === Kind.Refund || kind === Kind.Rollback
              ? { referenceExternalTransactionId: 'external-bet' }
              : {}),
          }),
        ),
      'INVALID_AMOUNT',
    );
  });
  test('LOSS não aceita valor financeiro', () => {
    expectCode(() => Transaction.create(props({ kind: Kind.Loss })), 'INVALID_AMOUNT');
  });
  test.each([
    [Kind.Refund, Kind.Bet, Direction.Credit],
    [Kind.Rollback, Kind.Bet, Direction.Credit],
    [Kind.Rollback, Kind.Win, Direction.Debit],
    [Kind.Rollback, Kind.Refund, Direction.Debit],
  ] as const)('%s de %s inverte a movimentação corretamente', (kind, referenceKind, direction) => {
    const reference =
      referenceKind === Kind.Refund
        ? Transaction.rehydrate({ ...props({ kind: Kind.Refund }), status: Status.Processed })
        : processed(referenceKind);
    const transaction = Transaction.create(
      props({ id: 'reversal', kind, referenceExternalTransactionId: 'external-bet' }),
    );
    expect(transaction.ledgerDirectionFor(reference)).toBe(direction);
    expectCode(() => transaction.validateReference(reference, true), 'ALREADY_REVERSED');
  });
  test('valida vínculo, tipo, valor e estado da referência', () => {
    const reversal = Transaction.create(
      props({ id: 'r', kind: Kind.Refund, referenceExternalTransactionId: 'external-bet' }),
    );
    expectCode(() => reversal.validateReference(processed(Kind.Win)), 'INVALID_REFERENCE_KIND');
    expectCode(
      () => reversal.validateReference(Transaction.create(props())),
      'REFERENCE_NOT_PROCESSED',
    );
    for (const changed of [
      { providerId: 'other' },
      { playerId: 'other' },
      { walletId: 'other' },
      { roundId: 'other' },
      { money: money('25.00', 'USD') },
      { externalTransactionId: 'other' },
    ]) {
      const reference = Transaction.rehydrate({ ...props(changed), status: Status.Processed });
      expectCode(() => reversal.validateReference(reference), 'REFERENCE_MISMATCH');
    }
    expectCode(
      () =>
        reversal.validateReference(
          Transaction.rehydrate({ ...props({ money: money('24.00') }), status: Status.Processed }),
        ),
      'INVALID_AMOUNT',
    );
  });
  test('pendência pode ser reprocessada sem reabrir estados terminais', () => {
    const transaction = Transaction.create(
      props({ id: 'r', kind: Kind.Refund, referenceExternalTransactionId: 'external-bet' }),
    );
    transaction.markPendingReference();
    expect(transaction.status).toBe(Status.PendingReference);
    expectCode(() => transaction.markProcessed(undefined, at), 'REFERENCE_REQUIRED');
    transaction.markProcessed('bet', at);
    expect(transaction.referenceTransactionId).toBe('bet');
    expect(transaction.processedAt?.toISOString()).toBe(at.toISOString());
    expectCode(() => transaction.markPendingReference(), 'INVALID_TRANSACTION_STATE');
  });
  test.each([Status.Processed, Status.Rejected, Status.Failed])(
    '%s nunca muda de estado',
    (status) => {
      const transaction = Transaction.rehydrate({ ...props(), status });
      for (const transition of [
        () => transaction.markProcessed(undefined, at),
        () => transaction.markPendingReference(),
        () => transaction.reject('INVALID_AMOUNT'),
        () => transaction.fail('INVALID_OPERATION'),
      ]) {
        expectCode(transition, 'INVALID_TRANSACTION_STATE');
      }
      expect(transaction.status).toBe(status);
    },
  );
  test('rejeição guarda motivo sem marcar processamento financeiro', () => {
    const transaction = Transaction.create(props());
    transaction.reject('INSUFFICIENT_FUNDS');
    expect(transaction.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect(transaction.processedAt).toBeUndefined();
  });
});

describe('Recuperação e falhas financeiras', () => {
  test('reidrata saldo e versão sem executar uma nova movimentação', () => {
    const restored = Wallet.rehydrate({
      id: 'w',
      playerId: 'p',
      currency: 'BRL',
      balance: money('17.50'),
      version: 8,
      createdAt: at,
      updatedAt: at,
    });
    expect(restored.balance.toString()).toBe('17.50');
    expect(restored.version).toBe(8);
  });
  test('overflow de crédito não modifica saldo nem versão', () => {
    const w = Wallet.open({
      id: 'w',
      playerId: 'p',
      initialBalance: money('999999999999999999.99'),
      at,
    });
    expectCode(() => w.credit(movement('0.01')), 'MONEY_OUT_OF_RANGE');
    expect(w.version).toBe(1);
    expect(w.balance.toString()).toBe('999999999999999999.99');
  });
  test('WIN referenciado pode pagar valor diferente da BET', () => {
    const win = Transaction.create(
      props({
        id: 'win',
        kind: Kind.Win,
        money: money('50.00'),
        referenceExternalTransactionId: 'external-bet',
      }),
    );
    expect(win.ledgerDirectionFor(processed())).toBe(Direction.Credit);
    expectCode(() => win.ledgerDirectionFor(), 'REFERENCE_REQUIRED');
  });
  test('BET e LOSS não podem carregar referências', () => {
    for (const kind of [Kind.Bet, Kind.Loss]) {
      expectCode(
        () =>
          Transaction.create(
            props({
              kind,
              money: money(kind === Kind.Loss ? '0.00' : '25.00'),
              referenceExternalTransactionId: 'external-bet',
            }),
          ),
        'INVALID_REFERENCE_KIND',
      );
    }
  });
  test('falha técnica permanente fica auditável e terminal', () => {
    const transaction = Transaction.create(props());
    transaction.fail('PERMANENT_INFRASTRUCTURE_FAILURE');
    expect(transaction.status).toBe(Status.Failed);
    expect(transaction.failureCode).toBe('PERMANENT_INFRASTRUCTURE_FAILURE');
    expect(transaction.isTerminal()).toBe(true);
  });
  test('WIN gasto não pode ser revertido causando saldo negativo', () => {
    const w = wallet();
    w.credit(movement('25.00'));
    w.debit(movement('125.00'));
    const rollback = Transaction.create(
      props({ id: 'r', kind: Kind.Rollback, referenceExternalTransactionId: 'external-bet' }),
    );
    expect(rollback.ledgerDirectionFor(processed(Kind.Win))).toBe(Direction.Debit);
    expectCode(() => w.debit(movement('25.00'), true), 'REVERSAL_INSUFFICIENT_FUNDS');
    rollback.reject('REVERSAL_INSUFFICIENT_FUNDS');
    expect(w.balance.isZero()).toBe(true);
    expect(w.version).toBe(3);
    expect(rollback.status).toBe(Status.Rejected);
  });
});

describe('Hash de negócio e conflito de idempotência', () => {
  test('preserva dinheiro e ignora chave, IDs internos e metadados', () => {
    const first = props({ money: money('25.00') });
    const other = props({
      id: 'other',
      idempotencyKey: 'other',
      payloadHash: 'other',
      money: money('25.00'),
    });
    expect(hashBusinessPayload(first)).toBe(hashBusinessPayload(other));
    expect(hashBusinessPayload(first)).toMatch(/^[a-f0-9]{64}$/);
  });
  test('alterar campo de negócio gera conflito, não replay', () => {
    const original = props();
    const hash = hashBusinessPayload(original);
    const transaction = Transaction.create({ ...original, payloadHash: hash });
    transaction.assertReplay(hash);
    for (const changed of [
      { money: money('26.00') },
      { providerId: 'other' },
      { roundId: 'other' },
      { gameId: 'other' },
      { walletId: 'other' },
      { playerId: 'other' },
      { kind: Kind.Win },
      { externalTransactionId: 'other' },
      { referenceExternalTransactionId: 'ref' },
    ]) {
      expectCode(
        () => transaction.assertReplay(hashBusinessPayload({ ...original, ...changed })),
        'IDEMPOTENCY_CONFLICT',
      );
    }
  });
});
