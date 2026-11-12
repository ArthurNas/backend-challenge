import { DynamicModule, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { CreateWallet } from './application/create-wallet';
import { FinancialStore } from './application/financial-store';
import { FinancialTelemetry } from './application/financial-telemetry.port';
import { ProcessWagerTransaction } from './application/process-wager-transaction';
import {
  DevelopmentProviderIdentity,
  ProviderIdentityPort,
} from './application/provider-identity.port';
import { ApiErrorFilter } from './http/api-error.filter';
import { MetricsController } from './http/metrics.controller';
import { WalletsController } from './http/wallets.controller';
import { WageringController } from './http/wagering.controller';
import { databaseConfig } from './infrastructure/database/database.config';
import { FinancialQueries } from './infrastructure/database/financial-queries';
import { PostgresFinancialStore } from './infrastructure/database/financial-store';
import { FinancialMetrics } from './infrastructure/observability/financial-metrics';
import { OperationalFinancialTelemetry } from './infrastructure/observability/financial-telemetry';
import { SqsGateway } from './infrastructure/messaging/sqs-gateway';
import { sqsConfig, SqsConfig } from './infrastructure/messaging/sqs.config';
import { WagerConsumer } from './infrastructure/messaging/wager-consumer';
import { OutboxRepository } from './infrastructure/database/outbox.repository';
import { OutboxPublisher } from './infrastructure/workers/outbox-publisher';
import { ReferenceWorker } from './infrastructure/workers/reference-worker';
import { WorkerHost } from './infrastructure/workers/worker-host';
import { ReadinessController } from './http/readiness.controller';

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close(true);
  }
}

@Module({})
export class FinancialModule {
  static register(
    databaseUrl: string | undefined,
    workers = false,
    queues: SqsConfig = sqsConfig(),
  ): DynamicModule {
    const config = databaseConfig(databaseUrl);

    return {
      module: FinancialModule,
      controllers: [WalletsController, WageringController, MetricsController, ReadinessController],
      providers: [
        { provide: MikroORM, useFactory: () => MikroORM.init({ ...config, connect: false }) },

        DatabaseLifecycle,
        FinancialMetrics,

        { provide: SqsGateway, useFactory: () => new SqsGateway(queues) },

        {
          provide: OutboxRepository,
          inject: [MikroORM],
          useFactory: (orm: MikroORM) => new OutboxRepository(orm),
        },

        {
          provide: FinancialTelemetry,
          inject: [FinancialMetrics],
          useFactory: (metrics: FinancialMetrics) => new OperationalFinancialTelemetry(metrics),
        },

        { provide: APP_FILTER, useClass: ApiErrorFilter },
        { provide: ProviderIdentityPort, useClass: DevelopmentProviderIdentity },

        {
          provide: FinancialStore,
          inject: [MikroORM, FinancialMetrics],
          useFactory: (orm: MikroORM, metrics: FinancialMetrics) =>
            new PostgresFinancialStore(orm, metrics),
        },

        {
          provide: CreateWallet,
          inject: [FinancialStore],
          useFactory: (store: FinancialStore) => new CreateWallet(store),
        },

        {
          provide: ProcessWagerTransaction,
          inject: [FinancialStore, ProviderIdentityPort, FinancialTelemetry],
          useFactory: (
            store: FinancialStore,
            identity: ProviderIdentityPort,
            telemetry: FinancialTelemetry,
          ) => new ProcessWagerTransaction(store, identity, telemetry),
        },

        {
          provide: FinancialQueries,
          inject: [MikroORM, FinancialMetrics],
          useFactory: (orm: MikroORM, metrics: FinancialMetrics) =>
            new FinancialQueries(orm, metrics),
        },

        ...(workers ? FinancialModule.workerProviders() : []),
      ],
    };
  }

  private static workerProviders() {
    return [
      {
        provide: WagerConsumer,
        inject: [SqsGateway, ProcessWagerTransaction, FinancialMetrics],
        useFactory: (
          gateway: SqsGateway,
          processor: ProcessWagerTransaction,
          metrics: FinancialMetrics,
        ) => new WagerConsumer(gateway, processor, metrics),
      },

      {
        provide: OutboxPublisher,
        inject: [OutboxRepository, SqsGateway, FinancialMetrics],
        useFactory: (outbox: OutboxRepository, gateway: SqsGateway, metrics: FinancialMetrics) =>
          new OutboxPublisher(outbox, gateway, metrics),
      },

      {
        provide: ReferenceWorker,
        inject: [MikroORM, ProcessWagerTransaction],
        useFactory: (orm: MikroORM, processor: ProcessWagerTransaction) =>
          new ReferenceWorker(orm, processor),
      },

      {
        provide: WorkerHost,
        inject: [WagerConsumer, OutboxPublisher, ReferenceWorker],
        useFactory: (
          consumer: WagerConsumer,
          publisher: OutboxPublisher,
          references: ReferenceWorker,
        ) => new WorkerHost(consumer, publisher, references),
      },
    ];
  }
}
