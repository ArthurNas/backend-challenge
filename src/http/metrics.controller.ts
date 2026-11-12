import { Controller, Get, Header, Inject } from '@nestjs/common';
import { FinancialMetrics } from '../infrastructure/observability/financial-metrics';
import { OutboxRepository } from '../infrastructure/database/outbox.repository';
import { SqsGateway } from '../infrastructure/messaging/sqs-gateway';

@Controller('metrics')
export class MetricsController {
  constructor(
    @Inject(FinancialMetrics) private readonly metrics: FinancialMetrics,
    @Inject(OutboxRepository) private readonly outbox: OutboxRepository,
    @Inject(SqsGateway) private readonly gateway: SqsGateway,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async get(): Promise<string> {
    const [lag, dlq] = await Promise.allSettled([
      this.outbox.lagSeconds(),
      this.gateway.deadLetterDepth(),
    ]);
    if (lag.status === 'fulfilled') this.metrics.gauge('wagering_outbox_lag_seconds', lag.value);
    else this.metrics.remove('wagering_outbox_lag_seconds');

    if (dlq.status === 'fulfilled') this.metrics.gauge('wagering_dlq_depth', dlq.value);
    else this.metrics.remove('wagering_dlq_depth');

    return this.metrics.render();
  }
}
