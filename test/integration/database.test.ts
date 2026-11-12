import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/database.config';
import {
  LedgerRecord,
  TransactionRecord,
  WalletRecord,
} from '../../src/infrastructure/database/entities';
import { WalletMapper } from '../../src/infrastructure/database/wallet.mapper';
import { PostgresWalletRepository } from '../../src/infrastructure/database/wallet.repository';
import { Wallet } from '../../src/domain/wallet';
import { Money } from '../../src/domain/money';
import { DomainError } from '../../src/domain/domain-error';
import { LedgerDirection, WalletLedgerEntry } from '../../src/domain/wallet-ledger-entry';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const databaseName = `wagering_test_${randomUUID().replaceAll('-', '')}`;
let admin: MikroORM;
let orm: MikroORM;
let databaseCreated = false;

const money = (amount: string) => Money.from({ amount, currency: 'BRL' });

async function createWallet(amount = '0.00', playerId: string = randomUUID()): Promise<Wallet> {
  const wallet = Wallet.open({
    id: randomUUID(),
    playerId,
    initialBalance: money(amount),
    at: new Date(),
  });
  await orm.em.fork().transactional((em) => persistWalletOpening(em, wallet));
  return wallet;
}

async function persistWalletOpening(em: EntityManager, wallet: Wallet): Promise<void> {
  await em.persistAndFlush(WalletMapper.toRecord(wallet));
  if (wallet.balance.isZero()) return;

  const transactionId = await insertTransaction(em, wallet, 'OPENING', wallet.balance.toString());
  const entry = WalletLedgerEntry.create({
    id: randomUUID(),
    walletId: wallet.id,
    transactionId,
    direction: LedgerDirection.Credit,
    money: wallet.balance,
    balanceBefore: Money.zero('BRL'),
    balanceAfter: wallet.balance,
    createdAt: new Date(),
  });
  await insertLedger(em, entry, 1);
}

async function insertTransaction(
  em: EntityManager,
  wallet: Wallet,
  kind: string,
  amount: string,
): Promise<string> {
  const id = randomUUID();
  const record = em.create(TransactionRecord, {
    id,
    providerId: 'provider-test',
    externalTransactionId: id,
    idempotencyKey: id,
    payloadHash: 'a'.repeat(64),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind,
    amount,
    currency: 'BRL',
    status: 'PROCESSED',
    createdAt: new Date(),
    processedAt: new Date(),
  });
  await em.persistAndFlush(record);
  return id;
}

async function insertLedger(
  em: EntityManager,
  entry: WalletLedgerEntry,
  version: number,
): Promise<void> {
  const record = em.create(LedgerRecord, {
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
  await em.persistAndFlush(record);
}

async function expectConstraint(action: () => Promise<unknown>): Promise<void> {
  let failure: unknown;
  try {
    await action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeDefined();
  expect(String(failure)).toMatch(/constraint|immutable|differs|requires|Ledger|ledger|negative/i);
}

integration('PostgreSQL real: migrations e integridade financeira', () => {
  beforeAll(async () => {
    admin = await MikroORM.init(databaseConfig(databaseUrl));
    await admin.em.getConnection().execute(`create database "${databaseName}"`);
    databaseCreated = true;
    const url = new URL(databaseUrl!);
    url.pathname = `/${databaseName}`;
    orm = await MikroORM.init(databaseConfig(url.toString()));
    await orm.migrator.up();
  }, 30000);

  afterAll(async () => {
    if (orm) await orm.close(true);
    if (databaseCreated) await admin.em.getConnection().execute(`drop database "${databaseName}"`);
    if (admin) await admin.close(true);
  }, 30000);

  test('migration é reversível e reaplicável', async () => {
    await orm.migrator.down({ to: 0 });
    const tables = await orm.em
      .getConnection()
      .execute<{ name: string | null }[]>("select to_regclass('public.wallets')::text as name");
    expect(tables[0]?.name).toBeNull();
    await orm.migrator.up();
  });

  test('ORM preserva centavos de valores grandes como string', async () => {
    const wallet = await createWallet('999999999999999999.98');
    const restored = await new PostgresWalletRepository(orm).findById(wallet.id);
    expect(restored?.balance.toString()).toBe('999999999999999999.98');
    expect(restored?.version).toBe(1);
  });

  test('rollback da segunda migration preserva rejeições com moeda divergente', async () => {
    const wallet = await createWallet();
    const id = randomUUID();
    const em = orm.em.fork();
    const record = em.create(TransactionRecord, {
      id,
      providerId: 'provider-test',
      externalTransactionId: id,
      idempotencyKey: id,
      payloadHash: 'c'.repeat(64),
      walletId: wallet.id,
      playerId: wallet.playerId,
      roundId: 'round',
      gameId: 'game',
      kind: 'BET',
      amount: '1.00',
      currency: 'USD',
      status: 'REJECTED',
      failureCode: 'CURRENCY_MISMATCH',
      createdAt: new Date(),
    });
    await em.persistAndFlush(record);
    await orm.migrator.down();
    await orm.migrator.down();
    await orm.migrator.down();
    expect((await orm.em.fork().findOneOrFail(TransactionRecord, { id })).currency).toBe('USD');
    await orm.migrator.up();
  });

  test('unicidade de carteira por jogador e moeda', async () => {
    const wallet = await createWallet();
    await expectConstraint(() => createWallet('0.00', wallet.playerId));
  });

  test.each(['-1.00', 'NaN'])(
    'banco rejeita saldo %s mesmo sem passar pelo domínio',
    async (amount) => {
      await expectConstraint(() =>
        orm.em
          .getConnection()
          .execute('insert into wallets values (?, ?, ?, ?, 1, now(), now())', [
            randomUUID(),
            randomUUID(),
            'BRL',
            amount,
          ]),
      );
    },
  );

  test('alteração de saldo sem ledger é desfeita no commit', async () => {
    const wallet = await createWallet();
    await expectConstraint(() =>
      orm.em.getConnection().execute('update wallets set balance = 10 where id = ?', [wallet.id]),
    );
    expect((await new PostgresWalletRepository(orm).findById(wallet.id))?.balance.toString()).toBe(
      '0.00',
    );
  });

  test('transação processada sem ledger não pode ser confirmada', async () => {
    const wallet = await createWallet();
    await expectConstraint(() =>
      orm.em.fork().transactional((em) => insertTransaction(em, wallet, 'WIN', '1.00')),
    );
    expect(await orm.em.fork().count(TransactionRecord, { walletId: wallet.id })).toBe(0);
  });

  test('LOSS processada não cria ledger nem incrementa versão', async () => {
    const wallet = await createWallet();
    await orm.em.fork().transactional((em) => insertTransaction(em, wallet, 'LOSS', '0.00'));
    expect(await orm.em.fork().count(LedgerRecord, { walletId: wallet.id })).toBe(0);
    expect((await new PostgresWalletRepository(orm).findById(wallet.id))?.version).toBe(1);
  });

  test.each(['idempotencyKey', 'externalTransactionId'] as const)(
    'banco impede duplicação por %s',
    async (field) => {
      const wallet = await createWallet();
      const id = await orm.em
        .fork()
        .transactional((em) => insertTransaction(em, wallet, 'LOSS', '0'));
      const original = await orm.em.fork().findOneOrFail(TransactionRecord, { id });
      const copy = {
        ...original,
        id: randomUUID(),
        idempotencyKey: String(randomUUID()),
        externalTransactionId: String(randomUUID()),
      };
      copy[field] = original[field];
      const em = orm.em.fork();
      const record = em.create(TransactionRecord, copy);
      await expectConstraint(() => em.persistAndFlush(record));
    },
  );

  test('ledger sem atualização de saldo não pode ser confirmado', async () => {
    const wallet = await createWallet();
    await expectConstraint(() =>
      orm.em.fork().transactional(async (em) => {
        const transactionId = await insertTransaction(em, wallet, 'WIN', '1.00');
        const entry = wallet.credit({
          entryId: randomUUID(),
          transactionId,
          money: money('1.00'),
          at: new Date(),
        });
        await insertLedger(em, entry, wallet.version);
      }),
    );
    expect(await orm.em.fork().count(TransactionRecord, { walletId: wallet.id })).toBe(0);
    expect(await orm.em.fork().count(LedgerRecord, { walletId: wallet.id })).toBe(0);
  });

  test.each([
    'update wallet_ledger_entries set amount = amount',
    'delete from wallet_ledger_entries',
    'truncate wallet_ledger_entries',
  ])('ledger impede mutação por SQL direto: %s', async (sql) => {
    await createWallet('10.00');
    await expectConstraint(() => orm.em.getConnection().execute(sql));
  });

  test('transação terminal não pode ser alterada', async () => {
    const wallet = await createWallet('10.00');
    await expectConstraint(() =>
      orm.em
        .getConnection()
        .execute(
          "update wager_transactions set status = 'PENDING', processed_at = null where wallet_id = ?",
          [wallet.id],
        ),
    );
  });

  test('LOSS terminal não pode ser excluída mesmo sem ledger', async () => {
    const wallet = await createWallet();
    await orm.em.fork().transactional((em) => insertTransaction(em, wallet, 'LOSS', '0'));
    await expectConstraint(() =>
      orm.em
        .getConnection()
        .execute('delete from wager_transactions where wallet_id = ?', [wallet.id]),
    );
    expect(await orm.em.fork().count(TransactionRecord, { walletId: wallet.id })).toBe(1);
  });

  test('falha antes do commit desfaz abertura, transação e ledger', async () => {
    const id = randomUUID();
    const wallet = Wallet.open({
      id,
      playerId: randomUUID(),
      initialBalance: money('10.00'),
      at: new Date(),
    });
    await expect(
      orm.em.fork().transactional(async (em) => {
        await persistWalletOpening(em, wallet);
        throw new Error('simulated crash');
      }),
    ).rejects.toThrow('simulated crash');
    expect(await orm.em.fork().count(WalletRecord, { id })).toBe(0);
    expect(await orm.em.fork().count(TransactionRecord, { walletId: id })).toBe(0);
    expect(await orm.em.fork().count(LedgerRecord, { walletId: id })).toBe(0);
  });

  test('duas conexões disputam 100.00 com BET de 80.00 sem saldo negativo', async () => {
    const wallet = await createWallet('100.00');
    const repository = new PostgresWalletRepository(orm);
    const bet = () =>
      repository.withLockedWallet(wallet.id, async (lockedWallet, em) => {
        const entryId = randomUUID();
        const transactionId = randomUUID();
        const entry = lockedWallet.debit({
          entryId,
          transactionId,
          money: money('80.00'),
          at: new Date(),
        });
        const record = em.create(TransactionRecord, {
          id: transactionId,
          providerId: 'provider-test',
          externalTransactionId: transactionId,
          idempotencyKey: transactionId,
          payloadHash: 'b'.repeat(64),
          walletId: wallet.id,
          playerId: wallet.playerId,
          roundId: 'round',
          gameId: 'game',
          kind: 'BET',
          amount: '80.00',
          currency: 'BRL',
          status: 'PROCESSED',
          createdAt: new Date(),
          processedAt: new Date(),
        });
        await em.persistAndFlush(record);
        await insertLedger(em, entry, lockedWallet.version);
      });
    const outcomes = await Promise.allSettled([bet(), bet()]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') {
      expect(rejected.reason).toBeInstanceOf(DomainError);
      expect((rejected.reason as DomainError).code).toBe('INSUFFICIENT_FUNDS');
    }
    expect((await repository.findById(wallet.id))?.balance.toString()).toBe('20.00');
    expect(
      await orm.em.fork().count(LedgerRecord, { walletId: wallet.id, direction: 'DEBIT' }),
    ).toBe(1);
  });
});
