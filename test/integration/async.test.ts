import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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
import {
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from '../../src/domain/wager-transaction';
import {
  LedgerRecord,
  OutboxRecord,
  TransactionRecord,
} from '../../src/infrastructure/database/entities';
import { FinancialQueries } from '../../src/infrastructure/database/financial-queries';
import { OutboxRepository } from '../../src/infrastructure/database/outbox.repository';
import { FinancialMetrics } from '../../src/infrastructure/observability/financial-metrics';
import { ReferenceWorker } from '../../src/infrastructure/workers/reference-worker';
import { WorkerHost } from '../../src/infrastructure/workers/worker-host';
import { OutboxPublisher } from '../../src/infrastructure/workers/outbox-publisher';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { parseWagerMessage } from '../../src/infrastructure/messaging/parse-wager-message';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs-gateway';
import { TestDatabase } from '../support/test-database';
import { TestSqs } from '../support/test-sqs';
import { ApiProcess } from '../support/api-process';
import { eventually } from '../support/eventually';
import { GetQueueAttributesCommand } from '@aws-sdk/client-sqs';

const databaseUrl = process.env.TEST_DATABASE_URL;
const endpoint = process.env.TEST_SQS_ENDPOINT;
const integration = describe.skipIf(!databaseUrl || !endpoint);
const database = new TestDatabase();
let sqs: TestSqs;
let app: INestApplication;
let processor: ProcessWagerTransaction;
let consumer: WagerConsumer;
let queries: FinancialQueries;
let references: ReferenceWorker;
let metrics: FinancialMetrics;

const money = (amount: string) => Money.from({ amount, currency: 'BRL' });
const context = { correlationId: 'async-test' };

async function wallet(): Promise<Wallet> {
  return app.get(CreateWallet).execute(randomUUID(), money('100.00'), context);
}

function command(target: Wallet, override: Partial<WagerCommand> = {}): WagerCommand {
  const externalId = randomUUID();
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    idempotencyKey: externalId,
    walletId: target.id,
    playerId: target.playerId,
    roundId: 'round',
    gameId: 'game',
    kind: Kind.Bet,
    money: money('25.00'),
    ...override,
  };
}

function envelope(request: WagerCommand) {
  return {
    messageId: randomUUID(),
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: { ...request, money: request.money.toJSON() },
  };
}

async function consistent(walletId: string, balance: string): Promise<void> {
  const result = await queries.reconcile(walletId, 'async-test');
  expect(result.consistent).toBe(true);
  expect(result.storedBalance.amount).toBe(balance);
}

async function due(transactionId: string): Promise<void> {
  await database.orm.em.execute(
    "update pending_references set next_attempt_at = now() - interval '1 second' where transaction_id = ?",
    [transactionId],
  );
}

async function publishAll(publishers: OutboxPublisher[]): Promise<void> {
  for (let batch = 0; batch < 100; batch += 1) {
    const results = await Promise.all(publishers.map((publisher) => publisher.runOnce()));
    if (results.every((result) => !result)) return;
  }
  throw new Error('Outbox did not drain');
}

function workerEnvironment(): Record<string, string> {
  return {
    TEST_WORKER_MODE: 'true',
    SQS_ENDPOINT: endpoint!,
    SQS_COMMAND_QUEUE: sqs.config.queues.commands,
    SQS_DLQ: sqs.config.queues.deadLetters,
    SQS_EVENT_QUEUE: sqs.config.queues.events,
  };
}

async function queueEmpty(queue = sqs): Promise<boolean> {
  const result = await queue.client.send(
    new GetQueueAttributesCommand({
      QueueUrl: await queue.gateway.queueUrl(queue.config.queues.commands),
      AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
    }),
  );
  return (
    Number(result.Attributes?.ApproximateNumberOfMessages) === 0 &&
    Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible) === 0
  );
}

async function installTransientFailure(walletId: string): Promise<void> {
  await database.orm.em.execute(`
    create function fail_test_command() returns trigger language plpgsql as $$
    begin
      if new.wallet_id = '${walletId}'::uuid and new.kind = 'BET' then
        raise exception 'Injected serialization failure' using errcode = '40001';
      end if;
      return new;
    end; $$;
    create trigger fail_test_command before insert on wager_transactions
      for each row execute function fail_test_command();
  `);
}

async function removeTransientFailure(): Promise<void> {
  await database.orm.em.execute(
    'drop trigger fail_test_command on wager_transactions; drop function fail_test_command();',
  );
}

integration('SQS e PostgreSQL reais em containers', () => {
  beforeAll(async () => {
    await database.start(databaseUrl!);
    sqs = new TestSqs(endpoint!);
    await sqs.start();
    app = await NestFactory.create(AppModule.register(database.url, false, sqs.config), {
      logger: false,
      abortOnError: false,
    });
    await app.init();
    processor = app.get(ProcessWagerTransaction);
    queries = app.get(FinancialQueries);
    metrics = app.get(FinancialMetrics);
    consumer = new WagerConsumer(sqs.gateway, processor, metrics);
    references = new ReferenceWorker(database.orm, processor);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await sqs?.close();
    await database.close();
  }, 30000);

  test('dois publishers publicam a mesma outbox sem perder eventos', async () => {
    const target = await wallet();
    const publishers = [
      new OutboxPublisher(new OutboxRepository(database.orm), sqs.gateway, metrics),
      new OutboxPublisher(new OutboxRepository(database.orm), sqs.gateway, metrics),
    ];
    await publishAll(publishers);
    expect(
      await database.orm.em
        .fork()
        .count(OutboxRecord, { aggregateId: target.id, publishedAt: { $ne: null } }),
    ).toBe(2);
    const ids = new Set<string>();
    for (let index = 0; index < 2; index += 1) {
      const received = await sqs.receive(sqs.config.queues.events);
      expect(received).toBeDefined();
      ids.add(JSON.parse(received!.Body!).eventId);
      await sqs.delete(sqs.config.queues.events, received!);
    }
    expect(ids.size).toBe(2);
    await consistent(target.id, '100.00');
  }, 15000);

  test('claim abandonado é retomado após expirar o lease', async () => {
    const target = await wallet();
    const repository = new OutboxRepository(database.orm);
    const abandoned = await repository.claim();
    expect(abandoned).toBeDefined();
    const publisher = new OutboxPublisher(new OutboxRepository(database.orm), sqs.gateway, metrics);
    await publisher.runOnce();
    expect(await repository.claim()).toBeUndefined();
    await database.orm.em.execute(
      "update outbox_messages set lease_until = now() - interval '1 second' where id = ?",
      [abandoned!.message.id],
    );
    await publisher.runOnce();
    expect(
      await database.orm.em
        .fork()
        .count(OutboxRecord, { aggregateId: target.id, publishedAt: { $ne: null } }),
    ).toBe(2);
    await consistent(target.id, '100.00');
  });

  test('falha de SQS mantém outbox persistida com backoff e permite retomada', async () => {
    const target = await wallet();
    const unavailable = new SqsGateway({ ...sqs.config, endpoint: 'http://127.0.0.1:1' });
    try {
      await expect(
        new OutboxPublisher(new OutboxRepository(database.orm), unavailable, metrics).runOnce(),
      ).rejects.toThrow();
    } finally {
      unavailable.close();
    }
    const failed = await database.orm.em
      .fork()
      .findOneOrFail(OutboxRecord, { aggregateId: target.id, attempts: 1 });
    expect(failed.nextAttemptAt).toBeDefined();
    expect(failed.publishedAt).toBeNull();
    await database.orm.em.execute(
      "update outbox_messages set next_attempt_at = now() - interval '1 second' where id = ?",
      [failed.id],
    );
    await publishAll([
      new OutboxPublisher(new OutboxRepository(database.orm), sqs.gateway, metrics),
    ]);
    expect(
      await database.orm.em
        .fork()
        .count(OutboxRecord, { aggregateId: target.id, publishedAt: { $ne: null } }),
    ).toBe(2);
    await consistent(target.id, '100.00');
  }, 15000);

  test('mensagem repetida tem inbox persistente e apenas um débito', async () => {
    const target = await wallet();
    const request = envelope(command(target));
    await sqs.gateway.request(request, target.id, randomUUID());
    await consumer.runOnce();
    await sqs.send(request, target.id);
    await new WagerConsumer(sqs.gateway, processor, metrics).runOnce();
    const inbox = await database.orm.em.execute<{ count: string }[]>(
      'select count(*)::text as count from inbox_messages where message_id = ?',
      [request.messageId],
    );
    expect(inbox[0]?.count).toBe('1');
    expect(
      await database.orm.em.fork().count(LedgerRecord, { walletId: target.id, direction: 'DEBIT' }),
    ).toBe(1);
    expect(await database.orm.em.fork().count(OutboxRecord, { aggregateId: target.id })).toBe(4);
    await consistent(target.id, '75.00');
  });

  test('redelivery depois de commit sem ack reaproveita o resultado persistido', async () => {
    const target = await wallet();
    const request = envelope(command(target));
    await sqs.send(request, target.id);
    const received = await sqs.receive(sqs.config.queues.commands, 1);
    const parsed = parseWagerMessage(received!.Body!);
    await processor.execute(parsed.command, parsed.context, parsed.delivery);
    await Bun.sleep(1100);
    await new WagerConsumer(sqs.gateway, processor, metrics).runOnce();
    expect(
      await database.orm.em.fork().count(LedgerRecord, { walletId: target.id, direction: 'DEBIT' }),
    ).toBe(1);
    await consistent(target.id, '75.00');
  });

  test('reuso de messageId com conteúdo diferente vai à DLQ sem novo débito', async () => {
    const target = await wallet();
    const request = envelope(command(target));
    await sqs.send(request, target.id);
    await consumer.runOnce();
    await sqs.send(
      { ...request, data: { ...request.data, money: { amount: '26.00', currency: 'BRL' } } },
      target.id,
    );
    await consumer.runOnce();
    const rejected = await sqs.receive(sqs.config.queues.deadLetters);
    expect(rejected?.MessageAttributes?.FailureCode?.StringValue).toBe('INBOX_PAYLOAD_CONFLICT');
    await sqs.delete(sqs.config.queues.deadLetters, rejected!);
    await consistent(target.id, '75.00');
  });

  test('mensagem inválida vai à DLQ e não bloqueia o próximo comando', async () => {
    await sqs.send('invalid-json', 'invalid');
    await consumer.runOnce();
    const rejected = await sqs.receive(sqs.config.queues.deadLetters);
    expect(rejected?.MessageAttributes?.FailureCode?.StringValue).toBe('INVALID_MESSAGE_JSON');
    await sqs.delete(sqs.config.queues.deadLetters, rejected!);
    const target = await wallet();
    await sqs.send(envelope(command(target)), target.id);
    await consumer.runOnce();
    await consistent(target.id, '75.00');
  });

  test('falha transitória desfaz inbox, aplica retry e só confirma após recuperação', async () => {
    const target = await wallet();
    const request = envelope(command(target));
    await installTransientFailure(target.id);
    try {
      await sqs.send(request, target.id);
      await consumer.runOnce();
      const inbox = await database.orm.em.execute<{ count: string }[]>(
        'select count(*)::text as count from inbox_messages where message_id = ?',
        [request.messageId],
      );
      expect(inbox[0]?.count).toBe('0');
      expect(
        await database.orm.em
          .fork()
          .count(LedgerRecord, { walletId: target.id, direction: 'DEBIT' }),
      ).toBe(0);
      await consistent(target.id, '100.00');
    } finally {
      await removeTransientFailure();
    }
    await Bun.sleep(2100);
    await consumer.runOnce();
    await consistent(target.id, '75.00');
  }, 15000);

  test('limite de recebimentos envia falha transitória à DLQ', async () => {
    const target = await wallet();
    await installTransientFailure(target.id);
    try {
      await sqs.send(envelope(command(target)), target.id);
      // Quatro entregas sem ack simulam mortes antes do processamento.
      for (let attempt = 0; attempt < 4; attempt += 1)
        expect(await sqs.receive(sqs.config.queues.commands, 0)).toBeDefined();
      await consumer.runOnce();
      const rejected = await sqs.receive(sqs.config.queues.deadLetters);
      expect(rejected?.MessageAttributes?.FailureCode?.StringValue).toBe(
        'PROCESSING_INFRASTRUCTURE_FAILURE',
      );
      await sqs.delete(sqs.config.queues.deadLetters, rejected!);
      await consistent(target.id, '100.00');
    } finally {
      await removeTransientFailure();
    }
  });

  test('processo morto depois do commit e antes do ack não duplica débito', async () => {
    const target = await wallet();
    const request = envelope(command(target));
    const child = await ApiProcess.start(database.url, {
      ...workerEnvironment(),
      TEST_WORKER_MODE: 'false',
      TEST_PAUSE_AFTER_COMMIT: 'true',
    });
    try {
      await sqs.send(request, target.id);
      await child.waitForCommit();
      await child.stop(true);
      await Bun.sleep(1100);
      await consumer.runOnce();
      expect(
        await database.orm.em
          .fork()
          .count(LedgerRecord, { walletId: target.id, direction: 'DEBIT' }),
      ).toBe(1);
      await consistent(target.id, '75.00');
    } finally {
      await child.stop(true);
    }
  }, 30000);

  test.each([Kind.Refund, Kind.Rollback])(
    '%s antes da BET é retomado sem duplicar efeito',
    async (kind) => {
      const target = await wallet();
      const bet = command(target);
      const reversal = command(target, {
        kind,
        referenceExternalTransactionId: bet.externalTransactionId,
      });
      const accepted = await processor.execute(reversal, context);
      expect(accepted.status).toBe(Status.PendingReference);
      await processor.execute(bet, context);
      await due(accepted.transactionId);
      await Promise.all([
        references.runOnce(),
        new ReferenceWorker(database.orm, processor).runOnce(),
      ]);
      const result = await processor.execute(reversal, context);
      expect(result.status).toBe(Status.Processed);
      expect(result.idempotentReplay).toBe(true);
      expect(
        await database.orm.em.fork().count(LedgerRecord, { transactionId: accepted.transactionId }),
      ).toBe(1);
      await consistent(target.id, '100.00');
    },
  );

  test('referência ausente usa backoff persistente e rejeita ao expirar TTL', async () => {
    const target = await wallet();
    const request = command(target, {
      kind: Kind.Refund,
      referenceExternalTransactionId: 'missing',
    });
    const accepted = await processor.execute(request, context);
    await due(accepted.transactionId);
    await references.runOnce();
    const state = await database.orm.em.execute<{ attempts: number; future: boolean }[]>(
      'select attempts, next_attempt_at > now() as future from pending_references where transaction_id = ?',
      [accepted.transactionId],
    );
    expect(state[0]).toEqual({ attempts: 1, future: true });
    await database.orm.em.execute(
      "update pending_references set expires_at = now() - interval '1 second', next_attempt_at = now() - interval '1 second' where transaction_id = ?",
      [accepted.transactionId],
    );
    await references.runOnce();
    const rejected = await processor.execute(request, context);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe('REFERENCE_NOT_FOUND_EXPIRED');
    await consistent(target.id, '100.00');
  });

  test('referência de outra wallet é rejeitada mesmo quando ainda está pendente', async () => {
    const originalWallet = await wallet();
    const otherWallet = await wallet();
    const original = command(originalWallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: 'missing-parent',
    });
    const pending = await processor.execute(original, context);
    const wrongReference = command(otherWallet, {
      kind: Kind.Refund,
      referenceExternalTransactionId: original.externalTransactionId,
    });
    const rejected = await processor.execute(wrongReference, context);
    expect(rejected.status).toBe(Status.Rejected);
    expect(rejected.failureCode).toBe('REFERENCE_MISMATCH');
    await database.orm.em.execute(
      "update pending_references set expires_at = now() - interval '1 second', next_attempt_at = now() - interval '1 second' where transaction_id = ?",
      [pending.transactionId],
    );
    await references.runOnce();
    await consistent(originalWallet.id, '100.00');
    await consistent(otherWallet.id, '100.00');
  });

  test('readiness exige banco migrado e três filas alcançáveis', async () => {
    await app.listen(0, '127.0.0.1');
    const response = await fetch(`${await app.getUrl()}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', checks: { postgres: 'up', sqs: 'up' } });
  });

  test.each(['postgres', 'sqs'] as const)(
    'readiness retorna 503 quando %s está indisponível',
    async (dependency) => {
      const url =
        dependency === 'postgres' ? 'postgresql://unused@127.0.0.1:1/unused' : database.url;
      const config =
        dependency === 'sqs' ? { ...sqs.config, endpoint: 'http://127.0.0.1:1' } : sqs.config;
      const unavailable = await NestFactory.create(AppModule.register(url, false, config), {
        logger: false,
        abortOnError: false,
      });
      try {
        await unavailable.listen(0, '127.0.0.1');
        const origin = await unavailable.getUrl();
        const response = await fetch(`${origin}/health/ready`);
        expect(response.status).toBe(503);
        const result = (await response.json()) as { checks: Record<string, string> };
        expect(result.checks[dependency]).toBe('down');
        expect((await fetch(`${origin}/health/live`)).status).toBe(200);
        if (dependency === 'sqs') expect((await fetch(`${origin}/metrics`)).status).toBe(200);
      } finally {
        await unavailable.close();
      }
    },
    15000,
  );

  test('três processos de workers consomem duplicatas e retomam após reinício', async () => {
    const target = await wallet();
    const request = envelope(command(target));
    const children: ApiProcess[] = [];
    try {
      for (let index = 0; index < 3; index += 1)
        children.push(await ApiProcess.start(database.url, workerEnvironment()));
      expect(new Set(children.map((child) => child.pid)).size).toBe(3);
      // Grupos diferentes forçam disputa no banco em vez de depender da ordenação FIFO.
      await Promise.all(Array.from({ length: 9 }, () => sqs.send(request, randomUUID())));
      await eventually(queueEmpty);
      expect(
        await database.orm.em
          .fork()
          .count(LedgerRecord, { walletId: target.id, direction: 'DEBIT' }),
      ).toBe(1);
      await children[0]!.stop();
      if (process.platform === 'win32') await Bun.sleep(5100);
      // SIGTERM no Windows pode encerrar sem drain. Avançar o lease simula a
      // passagem dos 120s de recuperação, sem tornar o teste artificialmente lento.
      await database.orm.em.execute(
        "update outbox_messages set lease_until = now() - interval '1 second' where published_at is null and lease_until is not null",
      );
      children[0] = await ApiProcess.start(database.url, workerEnvironment());
      await sqs.send(request, target.id);
      await eventually(queueEmpty);
      await eventually(
        async () => (await database.orm.em.fork().count(OutboxRecord, { publishedAt: null })) === 0,
      );
      await consistent(target.id, '75.00');
    } finally {
      await Promise.all(children.map((child) => child.stop()));
    }
  }, 60000);

  test('shutdown interrompe long polling e conclui mensagem já confirmada no banco', async () => {
    const target = await wallet();
    const isolated = new TestSqs(endpoint!);
    await isolated.start();
    let reachedCommit = false;
    const draining = new WagerConsumer(isolated.gateway, processor, metrics, {
      afterCommit: async () => {
        reachedCommit = true;
        await Bun.sleep(100);
      },
    });
    const host = new WorkerHost(
      draining,
      new OutboxPublisher(new OutboxRepository(database.orm), isolated.gateway, metrics),
      references,
    );
    await isolated.send(envelope(command(target)), target.id);
    host.onApplicationBootstrap();
    try {
      await eventually(async () => reachedCommit, 5000);
      await host.beforeApplicationShutdown();
      expect(await queueEmpty(isolated)).toBe(true);
      await consistent(target.id, '75.00');
    } finally {
      await host.beforeApplicationShutdown();
      await isolated.close();
    }
  }, 15000);
});
