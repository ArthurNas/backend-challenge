import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const port = Number(process.env.WORKER_PORT ?? '3001');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid WORKER_PORT');

  const app = await NestFactory.create(AppModule.register(process.env.DATABASE_URL, true), {
    logger: new ConsoleLogger({ json: true }),
  });

  app.enableShutdownHooks();
  await app.listen(port, '0.0.0.0');
}

void bootstrap().catch(() => {
  process.stderr.write('Worker startup failed\n');
  process.exitCode = 1;
});
