import { MikroORM } from '@mikro-orm/postgresql';
import { ProcessWagerTransaction } from '../../application/process-wager-transaction';
import { Logger } from '@nestjs/common';

export class ReferenceWorker {
  private readonly logger = new Logger('ReferenceWorker');

  constructor(
    private readonly orm: MikroORM,
    private readonly processor: ProcessWagerTransaction,
  ) {}

  async runOnce(): Promise<boolean> {
    const rows = await this.orm.em.execute<{ transaction_id: string }[]>(`
      select transaction_id from pending_references where next_attempt_at <= now()
      order by next_attempt_at, transaction_id limit 20
    `);
    let failed = false;

    for (const row of rows) {
      try {
        await this.processor.reprocess(row.transaction_id);
      } catch {
        failed = true;
        this.logger.warn({ code: 'REFERENCE_RETRY', transactionId: row.transaction_id });
      }
    }

    return rows.length > 0 && !failed;
  }
}
