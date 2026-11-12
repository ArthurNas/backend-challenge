import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test, setSystemTime } from 'bun:test';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { AppModule } from '../../src/app.module';
import { CreateWallet } from '../../src/application/create-wallet';
import {
  ProcessWagerTransaction,
  WagerCommand,
} from '../../src/application/process-wager-transaction';
import { Money } from '../../src/domain/money';
import { Wallet } from '../../src/domain/wallet';
import { LedgerDirection as Direction } from '../../src/domain/wallet-ledger-entry';
import { WagerTransactionKind as Kind } from '../../src/domain/wager-transaction';
import { databaseErrorCode } from '../../src/infrastructure/database/database-errors';
import { LedgerRecord, OutboxRecord } from '../../src/infrastructure/database/entities';
import { FinancialQueries } from '../../src/infrastructure/database/financial-queries';
import { OutboxRepository } from '../../src/infrastructure/database/outbox.repository';
import { TestDatabase } from '../support/test-database';
import { rawFinancialWrite, RawMovement } from '../support/raw-financial-write';

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const database = new TestDatabase();
const context = { correlationId: 'schema-review' };
let app: INestApplication;
let processor: ProcessWagerTransaction;
let queries: FinancialQueries;

function command(wallet: Wallet, kind = Kind.Bet): WagerCommand {
  const externalId = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: externalId,
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: 'round',
    gameId: 'game',
    kind,
    money: Money.from({ amount: '25.00', currency: wallet.currency }),
  };
}

async function wallet(amount = '100.00'): Promise<Wallet> {
  return app
    .get(CreateWallet)
    .execute(randomUUID(), Money.from({ amount, currency: 'BRL' }), context);
}

async function rejectsSQL(action: () => Promise<unknown>, expected = ['23514']): Promise<void> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect(expected).toContain(databaseErrorCode(caught)!);
}

async function consistent(target: Wallet, amount: string): Promise<void> {
  const result = await queries.reconcile(target.id, 'schema-review');
  expect(result.consistent).toBe(true);
  expect(result.storedBalance.amount).toBe(amount);
}

integration('Revisão de invariantes por SQL direto', () => {
  beforeAll(async () => {
    await database.start(databaseUrl!);
    app = await NestFactory.create(AppModule.register(database.url), {
      logger: false,
      abortOnError: false,
    });
    await app.init();
    processor = app.get(ProcessWagerTransaction);
    queries = app.get(FinancialQueries);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await database.close();
  }, 30000);

  test.each([
    "player_id = '00000000-0000-4000-8000-000000000001'",
    "currency = 'USD'",
    "created_at = created_at + interval '1 second'",
    "id = '00000000-0000-4000-8000-000000000002'",
  ])('identidade de wallet vazia é imutável: %s', async (update) => {
    const target = await wallet('0.00');
    await rejectsSQL(() =>
      database.orm.em.execute(`update wallets set ${update} where id = ?`, [target.id]),
    );
    await consistent(target, '0.00');
  });

  test.each([
    "payload = jsonb_set(payload, '{correlationId}', '\"changed\"'::jsonb)",
    "occurred_at = occurred_at + interval '1 second'",
  ])('conteúdo da outbox é imutável: %s', async (update) => {
    const target = await wallet();
    await rejectsSQL(() =>
      database.orm.em.execute(`update outbox_messages set ${update} where aggregate_id = ?`, [
        target.id,
      ]),
    );
    await consistent(target, '100.00');
  });

  test.each(['delete from outbox_messages', 'truncate outbox_messages'])(
    'eventos não podem ser apagados: %s',
    async (sql) => {
      await rejectsSQL(() => database.orm.em.execute(sql));
    },
  );

  test('metadata de publicação continua mutável e confirmação não pode ser desfeita', async () => {
    const repository = new OutboxRepository(database.orm);
    const claim = await repository.claim();
    expect(claim).toBeDefined();
    await repository.retry(claim!);
    await database.orm.em.execute(
      "update outbox_messages set next_attempt_at = now() - interval '1 second' where id = ?",
      [claim!.message.id],
    );
    const next = await repository.claim();
    expect(next).toBeDefined();
    await repository.published(next!);
    await rejectsSQL(() =>
      database.orm.em.execute('update outbox_messages set published_at = null where id = ?', [
        next!.message.id,
      ]),
    );
  });

  test('backoff e publicação usam relógio do banco mesmo com processo adiantado', async () => {
    const repository = new OutboxRepository(database.orm);
    const claim = await repository.claim();
    expect(claim).toBeDefined();
    setSystemTime(new Date('2040-01-01T00:00:00Z'));
    try {
      await repository.retry(claim!);
      const rows = await database.orm.em.execute<{ delay: number }[]>(
        'select extract(epoch from next_attempt_at - now())::float8 as delay from outbox_messages where id = ?',
        [claim!.message.id],
      );
      expect(rows[0]!.delay).toBeGreaterThan(0);
      expect(rows[0]!.delay).toBeLessThan(3);
      await database.orm.em.execute(
        "update outbox_messages set next_attempt_at = now() - interval '1 second' where id = ?",
        [claim!.message.id],
      );
      const next = await repository.claim();
      expect(next!.message.id).toBe(claim!.message.id);
      await repository.published(next!);
      const published = await database.orm.em.execute<{ recent: boolean }[]>(
        'select abs(extract(epoch from published_at - now())) < 5 as recent from outbox_messages where id = ?',
        [next!.message.id],
      );
      expect(published[0]?.recent).toBe(true);
    } finally {
      setSystemTime();
    }
  });

  test('publisher com token antigo não confirma nem reagenda o claim de outra instância', async () => {
    const repository = new OutboxRepository(database.orm);
    const old = await repository.claim();
    expect(old).toBeDefined();
    await database.orm.em.execute(
      "update outbox_messages set lease_until = now() - interval '1 second' where id = ?",
      [old!.message.id],
    );
    const current = await repository.claim();
    expect(current!.message.id).toBe(old!.message.id);
    expect(current!.token).not.toBe(old!.token);
    await repository.retry(old!);
    await repository.published(old!);
    const rows = await database.orm.em.execute<
      { claim_token: string; published_at: Date | null }[]
    >('select claim_token, published_at from outbox_messages where id = ?', [current!.message.id]);
    expect(rows[0]?.claim_token).toBe(current!.token);
    expect(rows[0]?.published_at).toBeNull();
    await repository.published(current!);
  });

  test('erro ao marcar publicação permite reagendar o mesmo claim', async () => {
    const repository = new OutboxRepository(database.orm);
    const claim = await repository.claim();
    expect(claim).toBeDefined();
    await database.orm.em.execute(`
      create function reject_test_publication() returns trigger language plpgsql as $$
      begin
        if new.published_at is not null then
          raise exception 'Injected publication persistence failure' using errcode = '40001';
        end if;
        return new;
      end; $$;
      create trigger reject_test_publication before update on outbox_messages
        for each row execute function reject_test_publication();
    `);
    try {
      await rejectsSQL(() => repository.published(claim!), ['40001']);
      expect(claim!.message.isPending()).toBe(true);
      await repository.retry(claim!);
      const record = await database.orm.em
        .fork()
        .findOneOrFail(OutboxRecord, { id: claim!.message.id });
      expect(record.publishedAt).toBeNull();
      expect(record.attempts).toBe(claim!.message.attempts);
      expect(record.nextAttemptAt).toBeDefined();
    } finally {
      await database.orm.em.execute(
        'drop trigger reject_test_publication on outbox_messages; drop function reject_test_publication();',
      );
    }
  });

  test.each([
    { kind: 'WIN', direction: Direction.Debit },
    { kind: 'BET', direction: Direction.Credit },
  ])('direção de ledger incompatível com $kind falha no commit', async (input) => {
    const target = await wallet();
    await rejectsSQL(() => rawFinancialWrite(database.orm, { ...input, wallet: target }));
    await consistent(target, '100.00');
  });

  test.each([
    { amount: '10.00' },
    { roundId: 'other-round' },
    { providerId: 'other-provider' },
    { playerId: '00000000-0000-4000-8000-000000000001' },
    { currency: 'USD' },
  ])('REFUND inválido é rejeitado pelo schema: %j', async (override) => {
    const target = await wallet();
    const bet = command(target);
    const processed = await processor.execute(bet, context);
    const input: RawMovement = {
      wallet: target,
      kind: 'REFUND',
      direction: Direction.Credit,
      referenceId: processed.transactionId,
      referenceExternalId: bet.externalTransactionId,
      ...override,
    };
    await rejectsSQL(() => rawFinancialWrite(database.orm, input), ['23514', '23503']);
    await consistent(target, '75.00');
  });

  test('REFUND de outra wallet e REFUND de WIN são rejeitados pelo schema', async () => {
    const first = await wallet();
    const other = await wallet();
    const bet = command(first);
    const processed = await processor.execute(bet, context);
    await rejectsSQL(() =>
      rawFinancialWrite(database.orm, {
        wallet: other,
        kind: 'REFUND',
        direction: Direction.Credit,
        referenceId: processed.transactionId,
        referenceExternalId: bet.externalTransactionId,
      }),
    );
    const win = command(first, Kind.Win);
    const won = await processor.execute(win, context);
    await rejectsSQL(() =>
      rawFinancialWrite(database.orm, {
        wallet: first,
        kind: 'REFUND',
        direction: Direction.Credit,
        referenceId: won.transactionId,
        referenceExternalId: win.externalTransactionId,
      }),
    );
    await consistent(first, '100.00');
    await consistent(other, '100.00');
  });

  test('controle positivo aceita REFUND válido e índice impede segunda reversão', async () => {
    const target = await wallet();
    const bet = command(target);
    const processed = await processor.execute(bet, context);
    const input: RawMovement = {
      wallet: target,
      kind: 'REFUND',
      direction: Direction.Credit,
      referenceId: processed.transactionId,
      referenceExternalId: bet.externalTransactionId,
    };
    await rawFinancialWrite(database.orm, input);
    await rejectsSQL(() => rawFinancialWrite(database.orm, input), ['23505']);
    expect(
      await database.orm.em
        .fork()
        .count(LedgerRecord, { walletId: target.id, direction: Direction.Credit }),
    ).toBe(2);
    await consistent(target, '100.00');
  });

  test('PENDING_REFERENCE não permite reescrever payload nem voltar para PENDING', async () => {
    const target = await wallet();
    const request = { ...command(target, Kind.Refund), referenceExternalTransactionId: 'missing' };
    const result = await processor.execute(request, context);
    await rejectsSQL(() =>
      database.orm.em.execute('update wager_transactions set amount = 26 where id = ?', [
        result.transactionId,
      ]),
    );
    await rejectsSQL(() =>
      database.orm.em.execute("update wager_transactions set status = 'PENDING' where id = ?", [
        result.transactionId,
      ]),
    );
    await consistent(target, '100.00');
  });

  test('LOSS não pode guardar uma referência interna sem referência externa', async () => {
    const target = await wallet();
    const bet = command(target);
    const processed = await processor.execute(bet, context);
    const id = randomUUID();
    await rejectsSQL(() =>
      database.orm.em.execute(
        `insert into wager_transactions(
      id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id,
      player_id, round_id, game_id, kind, amount, currency, status, reference_transaction_id,
      created_at, processed_at) values (?, 'provider-a', ?, ?, ?, ?, ?, 'round', 'game',
      'LOSS', 0, 'BRL', 'PROCESSED', ?, now(), now())`,
        [id, id, id, 'e'.repeat(64), target.id, target.playerId, processed.transactionId],
      ),
    );
    await consistent(target, '75.00');
  });

  test('readiness identifica banco com a última migration pendente', async () => {
    await app.listen(0, '127.0.0.1');
    await database.orm.migrator.down();
    try {
      const response = await fetch(`${await app.getUrl()}/health/ready`);
      expect(response.status).toBe(503);
      const result = (await response.json()) as { checks: { postgres: string } };
      expect(result.checks.postgres).toBe('down');
    } finally {
      await database.orm.migrator.up();
    }
  });
});
