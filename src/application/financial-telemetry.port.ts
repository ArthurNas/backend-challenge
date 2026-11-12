import type { EventContext } from '../domain/events/integration-event';
import type { TransactionIdentity } from './financial-store';
import type { WagerResponse } from './process-wager-transaction';

export abstract class FinancialTelemetry {
  abstract completed(
    identity: TransactionIdentity & { walletId: string },
    result: WagerResponse,
    context: EventContext,
    durationMilliseconds: number,
  ): void;
}
