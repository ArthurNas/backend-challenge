import { OutboxRepository } from '../database/outbox.repository';
import { SqsGateway } from '../messaging/sqs-gateway';
import { FinancialMetrics } from '../observability/financial-metrics';

export class OutboxPublisher {
  constructor(
    private readonly outbox: OutboxRepository,
    private readonly gateway: SqsGateway,
    private readonly metrics: FinancialMetrics,
  ) {}

  async runOnce(): Promise<boolean> {
    const claim = await this.outbox.claim();
    if (!claim) return false;

    try {
      await this.gateway.publish(
        claim.message.id,
        claim.message.aggregateId,
        claim.message.payload,
      );
      await this.outbox.published(claim);
    } catch (error) {
      this.metrics.increment('wagering_outbox_retries_total');
      await this.outbox.retry(claim);
      throw error;
    }

    return true;
  }
}
