import 'reflect-metadata';
import { ConsoleLogger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }

  const app = await NestFactory.create(AppModule.register(), {
    logger: new ConsoleLogger({ json: true }),
  });

  app.enableShutdownHooks();
  await app.listen(port, '0.0.0.0');
}

void bootstrap().catch(() => {
  process.stderr.write('Application startup failed\n');
  process.exitCode = 1;
});
