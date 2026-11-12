import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ProcessWagerTransaction } from '../application/process-wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction';
import { FinancialQueries } from '../infrastructure/database/financial-queries';
import { text, uuid, wagerCommand } from '../application/input-validation';

@Controller()
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransaction) private readonly processor: ProcessWagerTransaction,
    @Inject(FinancialQueries) private readonly queries: FinancialQueries,
  ) {}

  @Post('wagering/transactions')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') key: unknown,
    @Headers('x-correlation-id') correlation: unknown,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ) {
    const correlationId =
      correlation === undefined ? randomUUID() : text(correlation, 'CORRELATION_ID');
    const result = await this.processor.execute(wagerCommand(body, key), { correlationId });

    response.status(this.statusCode(result.status));

    return result;
  }

  @Get('wagering/transactions/:transactionId')
  get(@Param('transactionId') transactionId: string) {
    return this.queries.transaction(uuid(transactionId, 'TRANSACTION_ID'));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  byProvider(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalId: string,
  ) {
    return this.queries.providerTransaction(
      text(providerId, 'PROVIDER_ID'),
      text(externalId, 'EXTERNAL_TRANSACTION_ID'),
    );
  }

  private statusCode(status: WagerTransactionStatus): number {
    if (status === WagerTransactionStatus.Rejected) return 422;

    if (status === WagerTransactionStatus.Failed) return 500;

    if (status === WagerTransactionStatus.Processed) return 200;

    return 202;
  }
}
