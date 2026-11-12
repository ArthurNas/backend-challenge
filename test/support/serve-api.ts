import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { ProcessWagerTransaction } from '../../src/application/process-wager-transaction';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs-gateway';
import { sqsConfig } from '../../src/infrastructure/messaging/sqs.config';
import { WagerConsumer } from '../../src/infrastructure/messaging/wager-consumer';
import { FinancialMetrics } from '../../src/infrastructure/observability/financial-metrics';

async function serve(): Promise<void> {
  const app = await NestFactory.create(
    AppModule.register(process.env.DATABASE_URL, process.env.TEST_WORKER_MODE === 'true'),
    {
      logger: false,
      abortOnError: false,
    },
  );
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  console.log(JSON.stringify({ url: await app.getUrl(), pid: process.pid }));
  if (process.env.TEST_PAUSE_AFTER_COMMIT !== 'true') return;
  const gateway = new SqsGateway(sqsConfig(), 1);
  const consumer = new WagerConsumer(
    gateway,
    app.get(ProcessWagerTransaction),
    app.get(FinancialMetrics),
    {
      afterCommit: async () => {
        console.log(JSON.stringify({ phase: 'committed' }));
        await new Promise<void>(() => {});
      },
    },
  );
  while (true) await consumer.runOnce();
}

void serve().catch(() => {
  process.stderr.write('Test API startup failed\n');
  process.exitCode = 1;
});
