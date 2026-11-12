import { Message } from '@aws-sdk/client-sqs';
import { Logger } from '@nestjs/common';
import { ApplicationError } from '../../application/application-error';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { DomainError } from '../../domain/domain-error';
import { isTransientDatabaseError } from '../database/database-errors';
import { FinancialMetrics } from '../observability/financial-metrics';
import { parseWagerMessage } from './parse-wager-message';
import { SqsGateway } from './sqs-gateway';

export interface ConsumerHooks {
  afterCommit?(): Promise<void>;
}

export class WagerConsumer {
  private readonly logger = new Logger('WagerConsumer');
  private readonly receipts = new Map<string, ReturnType<typeof setInterval>>();

  constructor(
    private readonly gateway: SqsGateway,
    private readonly processor: ProcessWagerTransaction,
    private readonly metrics: FinancialMetrics,
    private readonly hooks: ConsumerHooks = {},
  ) {}

  async runOnce(signal?: AbortSignal): Promise<boolean> {
    const message = await this.gateway.receive(signal);
    if (!message?.ReceiptHandle) return false;

    const receipt = message.ReceiptHandle;
    if (signal?.aborted) {
      await this.gateway.visibility(receipt, 0);

      return true;
    }

    this.renewVisibility(receipt);

    try {
      await this.process(message);
      await this.hooks.afterCommit?.();
      await this.gateway.ack(receipt);
    } catch (error) {
      await this.handleFailure(message, error);
    } finally {
      clearInterval(this.receipts.get(receipt));
      this.receipts.delete(receipt);
    }

    return true;
  }

  async releaseInFlight(): Promise<void> {
    const receipts = [...this.receipts.keys()];

    for (const timer of this.receipts.values()) clearInterval(timer);

    const deadline = AbortSignal.timeout(5000);

    await Promise.allSettled(
      receipts.map((receipt) => this.gateway.visibility(receipt, 0, deadline)),
    );
  }

  private renewVisibility(receipt: string): void {
    const timer = setInterval(() => {
      void this.gateway.visibility(receipt, this.gateway.visibilitySeconds).catch(() => {
        this.logger.warn({ code: 'VISIBILITY_RENEWAL_FAILED' });
      });
    }, 20000);

    timer.unref();
    this.receipts.set(receipt, timer);
  }

  private async process(message: Message): Promise<void> {
    const parsed = parseWagerMessage(message.Body ?? '');

    await this.processor.execute(parsed.command, parsed.context, parsed.delivery);
  }

  private async handleFailure(message: Message, error: unknown): Promise<void> {
    const attempts = Number(message.Attributes?.ApproximateReceiveCount ?? '1');
    const code = this.failureCode(error);

    this.logger.warn({ ...this.failureContext(message), event: 'message_failure', code, attempts });

    if (this.isPermanent(error) || attempts >= 5) {
      await this.gateway.deadLetter(message, code);
      await this.gateway.ack(message.ReceiptHandle!);
      this.metrics.increment('wagering_dlq_messages_total');

      return;
    }

    this.metrics.increment('wagering_retries_total');
    await this.gateway.visibility(message.ReceiptHandle!, Math.min(2 ** attempts, 300));
  }

  private failureContext(message: Message) {
    const fallback = {
      correlationId: message.MessageId ?? null,
      messageId: message.MessageId ?? null,
      transactionId: null,
      walletId: null,
      providerId: null,
    };

    try {
      const parsed = parseWagerMessage(message.Body ?? '');

      return {
        ...fallback,
        correlationId: parsed.context.correlationId,
        messageId: parsed.delivery.messageId,
        walletId: parsed.command.walletId,
        providerId: parsed.command.providerId,
      };
    } catch {
      return fallback;
    }
  }

  private isPermanent(error: unknown): boolean {
    if (isTransientDatabaseError(error)) return false;
    // SDK errors e falhas de conexão não classificadas continuam elegíveis a retry.
    if (error instanceof ApplicationError || error instanceof DomainError) return true;

    return false;
  }

  private failureCode(error: unknown): string {
    if (error instanceof ApplicationError || error instanceof DomainError) return error.code;

    return 'PROCESSING_INFRASTRUCTURE_FAILURE';
  }
}
