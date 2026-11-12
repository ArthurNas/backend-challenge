import { Controller, Get, Inject, Res } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { SqsGateway } from '../infrastructure/messaging/sqs-gateway';
import { latestMigrationName } from '../infrastructure/database/database.config';

@Controller('health')
export class ReadinessController {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    @Inject(SqsGateway) private readonly gateway: SqsGateway,
  ) {}

  @Get('ready')
  async ready(@Res({ passthrough: true }) response: { status(code: number): unknown }) {
    const [postgres, sqs] = await Promise.allSettled([this.checkDatabase(), this.gateway.check()]);
    const healthy = postgres.status === 'fulfilled' && sqs.status === 'fulfilled';

    response.status(healthy ? 200 : 503);

    return {
      status: healthy ? 'ok' : 'error',
      checks: {
        postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
        sqs: sqs.status === 'fulfilled' ? 'up' : 'down',
      },
    };
  }

  private async checkDatabase(): Promise<void> {
    await this.orm.em.execute('select 1 from inbox_messages limit 0');

    const applied = await this.orm.em.execute<{ name: string }[]>(
      'select name from mikro_orm_migrations where name = ?',
      [latestMigrationName],
    );
    if (applied.length === 0) throw new Error('Database migrations are pending');
  }
}
