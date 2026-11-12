import { MikroORM } from '@mikro-orm/postgresql';
import { FinancialStore, FinancialUnitOfWork } from '../../application/financial-store';
import { databaseErrorCode } from './database-errors';
import { PostgresFinancialUnitOfWork } from './financial-unit-of-work';
import { FinancialMetrics } from '../observability/financial-metrics';

export class PostgresFinancialStore extends FinancialStore {
  constructor(
    private readonly orm: MikroORM,
    private readonly metrics: FinancialMetrics,
  ) {
    super();
  }

  async transaction<T>(work: (unit: FinancialUnitOfWork) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.orm.em.fork().transactional(async (em) => {
          await em.execute("set local lock_timeout = '5s'");

          return work(new PostgresFinancialUnitOfWork(em));
        });
      } catch (error) {
        if (!this.canRetry(error) || attempt === 2) throw error;

        this.metrics.increment('wagering_retries_total');
        if (['40P01', '55P03', '40001'].includes(databaseErrorCode(error) ?? '')) {
          this.metrics.increment('wagering_lock_conflicts_total');
        }

        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    }

    throw new Error('Unreachable transaction retry state');
  }

  private canRetry(error: unknown): boolean {
    return ['23505', '40001', '40P01', '55P03'].includes(databaseErrorCode(error) ?? '');
  }
}
