import { Logger } from '@nestjs/common';
import { FinancialTelemetry } from '../../application/financial-telemetry.port';
import type { WagerResponse } from '../../application/process-wager-transaction';
import type { TransactionIdentity } from '../../application/financial-store';
import type { EventContext } from '../../domain/events/integration-event';
import { FinancialMetrics } from './financial-metrics';

export class OperationalFinancialTelemetry extends FinancialTelemetry {
  private readonly logger = new Logger('Wagering');

  constructor(private readonly metrics: FinancialMetrics) {
    super();
  }

  completed(
    identity: TransactionIdentity & { walletId: string },
    result: WagerResponse,
    context: EventContext,
    durationMilliseconds: number,
  ): void {
    const counter = result.idempotentReplay
      ? 'wagering_duplicates_total'
      : 'wagering_transactions_total';
    const labels = result.idempotentReplay ? '' : `status="${result.status}"`;

    this.metrics.increment(counter, labels);
    this.metrics.increment('wagering_processing_seconds_sum', '', durationMilliseconds / 1000);
    this.metrics.increment('wagering_processing_seconds_count');
    this.logger.log({
      event: 'wager_transaction_completed',
      correlationId: context.correlationId,
      messageId: context.causationId ?? null,
      transactionId: result.transactionId,
      walletId: identity.walletId,
      providerId: identity.providerId,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
    });
  }
}
