import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { HealthModule } from '../src/health/health.module';

const app = await NestFactory.create(HealthModule, { logger: false });

try {
  await app.listen(0, '127.0.0.1');

  const response = await fetch(`${await app.getUrl()}/health/live`);
  const body: unknown = await response.json();
  if (
    response.status !== 200 ||
    typeof body !== 'object' ||
    body === null ||
    !('status' in body) ||
    body.status !== 'ok'
  ) {
    throw new Error('Liveness smoke check failed');
  }

  console.log(JSON.stringify({ httpStatus: response.status, body }));
} finally {
  await app.close();
}
