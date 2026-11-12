import { DynamicModule, Module } from '@nestjs/common';
import { HealthModule } from './health/health.module';
import { FinancialModule } from './financial.module';
import { sqsConfig, SqsConfig } from './infrastructure/messaging/sqs.config';

@Module({ imports: [HealthModule] })
export class AppModule {
  static register(
    databaseUrl = process.env.DATABASE_URL,
    workers = false,
    queues: SqsConfig = sqsConfig(),
  ): DynamicModule {
    return { module: AppModule, imports: [FinancialModule.register(databaseUrl, workers, queues)] };
  }
}
