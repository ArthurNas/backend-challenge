import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { WagerResponse } from '../../src/application/process-wager-transaction';
import { WagerTransactionStatus } from '../../src/domain/wager-transaction';
import { ApiProcess } from '../support/api-process';
import {
  LedgerRecord,
  OutboxRecord,
  TransactionRecord,
  WalletRecord,
} from '../../src/infrastructure/database/entities';
import { TestDatabase } from '../support/test-database';

interface WalletView {
  id: string;
  playerId: string;
  balance: { amount: string; currency: string };
  version: number;
}

interface WagerBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const database = new TestDatabase();
let app: INestApplication;
let baseUrl: string;

async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  return { status: response.status, body: (await response.json()) as T };
}

async function createWallet(amount = '100.00'): Promise<WalletView> {
  const response = await request<WalletView>('/wallets', 'POST', {
    playerId: randomUUID(),
    initialBalance: { amount, currency: 'BRL' },
  });
  expect(response.status).toBe(201);
  return response.body;
}

function wager(wallet: WalletView, overrides: Partial<WagerBody> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round',
    gameId: 'game',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
    ...overrides,
  };
}

function submit(body: WagerBody, key = `${body.providerId}:${body.externalTransactionId}`) {
  return request<WagerResponse & { code?: string }>('/wagering/transactions', 'POST', body, {
    'idempotency-key': key,
    'x-correlation-id': 'api-test',
  });
}

async function assertReconciled(walletId: string, amount: string): Promise<void> {
  const result = await request<{
    consistent: boolean;
    storedBalance: { amount: string };
    calculatedBalance: { amount: string };
  }>(`/wallets/${walletId}/reconciliation`, 'POST');
  expect(result.status).toBe(200);
  expect(result.body.consistent).toBe(true);
  expect(result.body.storedBalance.amount).toBe(amount);
  expect(result.body.calculatedBalance.amount).toBe(amount);
}

integration('API financeira com PostgreSQL real', () => {
  beforeAll(async () => {
    await database.start(databaseUrl!);
    app = await NestFactory.create(AppModule.register(database.url), {
      logger: false,
      abortOnError: false,
    });
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await database.close();
  }, 30000);

  test('health continua público e criação positiva é atômica com OPENING e eventos', async () => {
    expect((await request('/health/live')).status).toBe(200);
    const wallet = await createWallet();
    expect(wallet.version).toBe(1);
    expect(
      await database.orm.em
        .fork()
        .count(TransactionRecord, { walletId: wallet.id, kind: 'OPENING' }),
    ).toBe(1);
    expect(await database.orm.em.fork().count(LedgerRecord, { walletId: wallet.id })).toBe(1);
    expect(await database.orm.em.fork().count(OutboxRecord, { aggregateId: wallet.id })).toBe(2);
    await assertReconciled(wallet.id, '100.00');
  });

  test('abertura zero não cria transação, ledger nem evento de saldo', async () => {
    const wallet = await createWallet('0.00');
    expect(wallet.version).toBe(1);
    expect(await database.orm.em.fork().count(TransactionRecord, { walletId: wallet.id })).toBe(0);
    expect(await database.orm.em.fork().count(OutboxRecord, { aggregateId: wallet.id })).toBe(0);
    await assertReconciled(wallet.id, '0.00');
  });

  test('wallet duplicada retorna 409', async () => {
    const wallet = await createWallet();
    const response = await request('/wallets', 'POST', {
      playerId: wallet.playerId,
      initialBalance: { amount: '0.00', currency: 'BRL' },
    });
    expect(response.status).toBe(409);
  });

  test('replay retorna saldo histórico mesmo depois de outra operação', async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    const first = await submit(body);
    expect(first.status).toBe(200);
    expect(first.body.balance.amount).toBe('75.00');
    expect((await submit(wager(wallet))).status).toBe(200);
    const replay = await submit(body);
    expect(replay.body).toEqual({ ...first.body, idempotentReplay: true });
    expect((await request<WalletView>(`/wallets/${wallet.id}`)).body.balance.amount).toBe('50.00');
    await assertReconciled(wallet.id, '50.00');
  });

  test('mesma key divergente e mesma identidade com outra key retornam 409', async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    await submit(body);
    expect((await submit({ ...body, money: { amount: '26.00', currency: 'BRL' } })).status).toBe(
      409,
    );
    expect((await submit(body, 'another-key')).status).toBe(409);
    await assertReconciled(wallet.id, '75.00');
  });

  test('rejeição por saldo fica persistida e replay não gera eventos adicionais', async () => {
    const wallet = await createWallet('10.00');
    const body = wager(wallet);
    const first = await submit(body);
    expect(first.status).toBe(422);
    expect(first.body.failureCode).toBe('INSUFFICIENT_FUNDS');
    expect((await submit(body)).body).toEqual({ ...first.body, idempotentReplay: true });
    expect(
      await database.orm.em
        .fork()
        .count(TransactionRecord, { walletId: wallet.id, status: 'REJECTED' }),
    ).toBe(1);
    expect(await database.orm.em.fork().count(OutboxRecord, { aggregateId: wallet.id })).toBe(3);
    await assertReconciled(wallet.id, '10.00');
  });

  test.each([
    { playerId: randomUUID(), expected: 'WALLET_PLAYER_MISMATCH' },
    { money: { amount: '25.00', currency: 'USD' }, expected: 'CURRENCY_MISMATCH' },
  ])('rejeição de identidade fica auditável: $expected', async ({ expected, ...override }) => {
    const wallet = await createWallet();
    const response = await submit(wager(wallet, override));
    expect(response.status).toBe(422);
    expect(response.body.failureCode).toBe(expected);
    expect(
      await database.orm.em
        .fork()
        .count(TransactionRecord, { id: response.body.transactionId, status: 'REJECTED' }),
    ).toBe(1);
    await assertReconciled(wallet.id, '100.00');
  });

  test('LOSS não altera saldo nem versão e gera apenas evento de processamento', async () => {
    const wallet = await createWallet();
    const result = await submit(
      wager(wallet, { kind: 'LOSS', money: { amount: '0.00', currency: 'BRL' } }),
    );
    expect(result.status).toBe(200);
    expect((await request<WalletView>(`/wallets/${wallet.id}`)).body.version).toBe(1);
    expect(await database.orm.em.fork().count(LedgerRecord, { walletId: wallet.id })).toBe(1);
    expect(await database.orm.em.fork().count(OutboxRecord, { aggregateId: wallet.id })).toBe(3);
    await assertReconciled(wallet.id, '100.00');
  });

  test('REFUND integral só pode reverter a BET uma vez', async () => {
    const wallet = await createWallet();
    const bet = wager(wallet);
    await submit(bet);
    const refund = wager(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect((await submit(refund)).status).toBe(200);
    const duplicate = await submit({ ...refund, externalTransactionId: randomUUID() });
    expect(duplicate.status).toBe(422);
    expect(duplicate.body.failureCode).toBe('ALREADY_REVERSED');
    await assertReconciled(wallet.id, '100.00');
  });

  test('WIN gasto não pode ser revertido; rejeição usa código específico', async () => {
    const wallet = await createWallet('0.00');
    const win = wager(wallet, { kind: 'WIN' });
    expect((await submit(win)).status).toBe(200);
    await submit(wager(wallet));
    const rollback = await submit(
      wager(wallet, {
        kind: 'ROLLBACK',
        referenceExternalTransactionId: win.externalTransactionId,
      }),
    );
    expect(rollback.status).toBe(422);
    expect(rollback.body.failureCode).toBe('REVERSAL_INSUFFICIENT_FUNDS');
    await assertReconciled(wallet.id, '0.00');
  });

  test('referência ausente retorna 202 sem movimentar saldo', async () => {
    const wallet = await createWallet();
    const response = await submit(
      wager(wallet, { kind: 'REFUND', referenceExternalTransactionId: 'not-arrived' }),
    );
    expect(response.status).toBe(202);
    expect(response.body.status).toBe(WagerTransactionStatus.PendingReference);
    expect(
      await database.orm.em.fork().count(OutboxRecord, {
        aggregateId: wallet.id,
        eventType: 'WagerTransactionPendingReference',
      }),
    ).toBe(1);
    await assertReconciled(wallet.id, '100.00');
  });

  test('REFUND parcial ou em outra rodada é rejeitado sem crédito', async () => {
    const wallet = await createWallet();
    const bet = wager(wallet);
    await submit(bet);
    const refund = wager(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    const partial = await submit({ ...refund, money: { amount: '10.00', currency: 'BRL' } });
    expect(partial.status).toBe(422);
    expect(partial.body.failureCode).toBe('INVALID_AMOUNT');
    const otherRound = await submit({
      ...refund,
      externalTransactionId: randomUUID(),
      roundId: 'other-round',
    });
    expect(otherRound.status).toBe(422);
    expect(otherRound.body.failureCode).toBe('REFERENCE_MISMATCH');
    await assertReconciled(wallet.id, '75.00');
  });

  test('ROLLBACK de REFUND inverte o crédito e preserva a cadeia de saldos', async () => {
    const wallet = await createWallet();
    const bet = wager(wallet);
    await submit(bet);
    const refund = wager(wallet, {
      kind: 'REFUND',
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    await submit(refund);
    const rollback = wager(wallet, {
      kind: 'ROLLBACK',
      referenceExternalTransactionId: refund.externalTransactionId,
    });
    expect((await submit(rollback)).status).toBe(200);
    await assertReconciled(wallet.id, '75.00');
  });

  test('duas REFUND simultâneas não duplicam a reversão', async () => {
    const wallet = await createWallet();
    const bet = wager(wallet);
    await submit(bet);
    const refund = { kind: 'REFUND', referenceExternalTransactionId: bet.externalTransactionId };
    const responses = await Promise.all([
      submit(wager(wallet, refund)),
      submit(wager(wallet, refund)),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    await assertReconciled(wallet.id, '100.00');
  });

  test('wallets distintas movimentam saldo em paralelo', async () => {
    const wallets = await Promise.all(Array.from({ length: 5 }, () => createWallet()));
    const responses = await Promise.all(wallets.map((wallet) => submit(wager(wallet))));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await Promise.all(wallets.map((wallet) => assertReconciled(wallet.id, '75.00')));
  });

  test('reconciliação sinaliza divergência e contabiliza métrica sem corrigir saldo', async () => {
    const wallet = await createWallet();
    // Injeção de corrupção somente neste banco descartável. Simula um dado legado inválido.
    await database.orm.em.fork().transactional(async (em) => {
      await em.execute('alter table wallets disable trigger wallet_row_consistency');
      await em.execute('update wallets set balance = 90 where id = ?', [wallet.id]);
      await em.execute('alter table wallets enable trigger wallet_row_consistency');
    });
    try {
      const response = await request<{ consistent: boolean; difference: { amount: string } }>(
        `/wallets/${wallet.id}/reconciliation`,
        'POST',
      );
      expect(response.status).toBe(200);
      expect(response.body.consistent).toBe(false);
      expect(response.body.difference.amount).toBe('-10.00');
      expect((await request<WalletView>(`/wallets/${wallet.id}`)).body.balance.amount).toBe(
        '90.00',
      );
      const metrics = await fetch(`${baseUrl}/metrics`).then((response) => response.text());
      expect(metrics).toContain('wagering_reconciliation_mismatches_total 1');
    } finally {
      await database.orm.em.execute('update wallets set balance = 100 where id = ?', [wallet.id]);
    }
  });

  test('infraestrutura indisponível retorna 503 e liveness permanece 200', async () => {
    const unavailable = await NestFactory.create(
      AppModule.register('postgresql://unused@127.0.0.1:1/unused'),
      {
        logger: false,
        abortOnError: false,
      },
    );
    try {
      await unavailable.listen(0, '127.0.0.1');
      const url = await unavailable.getUrl();
      const response = await fetch(`${url}/wallets/${randomUUID()}`, {
        signal: AbortSignal.timeout(10000),
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: 'INFRASTRUCTURE_UNAVAILABLE',
        statusCode: 503,
      });
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
    } finally {
      await unavailable.close();
    }
  }, 15000);

  test('consulta por ID e por identidade do provedor retorna a mesma operação', async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    const submitted = await submit(body);
    const byId = await request(`/wagering/transactions/${submitted.body.transactionId}`);
    const byProvider = await request(
      `/providers/${body.providerId}/wagering/transactions/${body.externalTransactionId}`,
    );
    expect(byId.status).toBe(200);
    expect(byProvider.body).toEqual(byId.body);
  });

  test('ledger pagina por cursor estável sem repetir lançamentos', async () => {
    const wallet = await createWallet();
    await submit(wager(wallet));
    const first = await request<{ items: { id: string }[]; nextCursor: string }>(
      `/wallets/${wallet.id}/ledger?limit=1`,
    );
    const second = await request<{ items: { id: string }[]; nextCursor: null }>(
      `/wallets/${wallet.id}/ledger?limit=1&cursor=${first.body.nextCursor}`,
    );
    expect(first.body.items).toHaveLength(1);
    expect(second.body.items).toHaveLength(1);
    expect(first.body.items[0]?.id).not.toBe(second.body.items[0]?.id);
    expect(second.body.nextCursor).toBeNull();
    expect((await request(`/wallets/${wallet.id}/ledger?cursor=invalid`)).status).toBe(400);
  });

  test.each(['OPENING', 'UNKNOWN'])('operação externa %s é inválida', async (kind) => {
    const wallet = await createWallet();
    expect((await submit(wager(wallet, { kind }))).status).toBe(400);
  });

  test.each(['25', '25.0', '25.001'])(
    'escala inválida %s é rejeitada na abertura e na aposta',
    async (amount) => {
      const wallet = await createWallet();
      const response = await submit(wager(wallet, { money: { amount, currency: 'BRL' } }));
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('INVALID_MONEY');
      const opening = await request<{ code: string }>('/wallets', 'POST', {
        playerId: randomUUID(),
        initialBalance: { amount, currency: 'BRL' },
      });
      expect(opening.status).toBe(400);
      expect(opening.body.code).toBe('INVALID_MONEY');
      await assertReconciled(wallet.id, '100.00');
    },
  );

  test('header obrigatório, número monetário e mais de duas casas são inválidos', async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    expect((await request('/wagering/transactions', 'POST', body)).status).toBe(400);
    expect((await submit({ ...body, money: { amount: '1.001', currency: 'BRL' } })).status).toBe(
      400,
    );
    expect(
      (
        await request('/wallets', 'POST', {
          playerId: randomUUID(),
          initialBalance: { amount: 10, currency: 'BRL' },
        })
      ).status,
    ).toBe(400);
  });

  test('50 submissões paralelas geram um débito e um par de eventos', async () => {
    const wallet = await createWallet();
    const body = wager(wallet);
    const responses = await Promise.all(Array.from({ length: 50 }, () => submit(body)));
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
    expect(new Set(responses.map((response) => response.body.transactionId)).size).toBe(1);
    expect(
      await database.orm.em.fork().count(LedgerRecord, { walletId: wallet.id, direction: 'DEBIT' }),
    ).toBe(1);
    expect(await database.orm.em.fork().count(OutboxRecord, { aggregateId: wallet.id })).toBe(4);
    await assertReconciled(wallet.id, '75.00');
  }, 30000);

  test('duas BET 80 simultâneas persistem um sucesso e uma rejeição', async () => {
    const wallet = await createWallet();
    const responses = await Promise.all([
      submit(wager(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
      submit(wager(wallet, { money: { amount: '80.00', currency: 'BRL' } })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 422]);
    expect(
      await database.orm.em
        .fork()
        .count(TransactionRecord, { walletId: wallet.id, status: 'REJECTED' }),
    ).toBe(1);
    expect(
      await database.orm.em.fork().count(LedgerRecord, { walletId: wallet.id, direction: 'DEBIT' }),
    ).toBe(1);
    await assertReconciled(wallet.id, '20.00');
  });

  test('três processos independentes deduplicam e sobrevivem ao reinício', async () => {
    const children: ApiProcess[] = [];
    const wallet = await createWallet();
    const body = wager(wallet);
    try {
      // Inicialização sequencial permite encerrar todo processo já criado se um falhar.
      for (let index = 0; index < 3; index += 1)
        children.push(await ApiProcess.start(database.url));
      expect(new Set(children.map((child) => child.pid)).size).toBe(3);
      expect(children.every((child) => child.pid !== process.pid)).toBe(true);
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, index) => {
          const child = children[index % 3]!;
          return child.submit<WagerResponse>(
            body,
            `${body.providerId}:${body.externalTransactionId}`,
          );
        }),
      );
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(responses.filter((response) => !response.body.idempotentReplay)).toHaveLength(1);
      const firstResult = responses[0]!.body;
      await children[0]!.stop();
      const restarted = await ApiProcess.start(database.url);
      children[0] = restarted;
      const replay = await restarted.submit<WagerResponse>(
        body,
        `${body.providerId}:${body.externalTransactionId}`,
      );
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ ...firstResult, idempotentReplay: true });
      expect(
        await database.orm.em
          .fork()
          .count(LedgerRecord, { walletId: wallet.id, direction: 'DEBIT' }),
      ).toBe(1);
      expect(await database.orm.em.fork().count(OutboxRecord, { aggregateId: wallet.id })).toBe(4);
      await assertReconciled(wallet.id, '75.00');
    } finally {
      await Promise.all(children.map((child) => child.stop()));
    }
  }, 30000);

  test('falha na outbox desfaz carteira, abertura e ledger', async () => {
    const playerId = randomUUID();
    await database.orm.em.execute(`
      create function fail_test_outbox() returns trigger language plpgsql as $$
      begin raise exception 'Injected outbox failure'; end; $$;
      create trigger fail_test_outbox before insert on outbox_messages for each row execute function fail_test_outbox();
    `);
    try {
      const result = await request('/wallets', 'POST', {
        playerId,
        initialBalance: { amount: '10.00', currency: 'BRL' },
      });
      expect(result.status).toBe(500);
      expect(await database.orm.em.fork().count(WalletRecord, { playerId })).toBe(0);
      expect(await database.orm.em.fork().count(TransactionRecord, { playerId })).toBe(0);
    } finally {
      await database.orm.em.execute(
        'drop trigger fail_test_outbox on outbox_messages; drop function fail_test_outbox();',
      );
    }
  });
});
