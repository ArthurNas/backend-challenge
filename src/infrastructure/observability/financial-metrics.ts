import { WagerTransactionStatus } from '../../domain/wager-transaction';

export class FinancialMetrics {
  private readonly counters = new Map<string, number>();

  constructor() {
    for (const status of Object.values(WagerTransactionStatus)) {
      this.counters.set(`wagering_transactions_total{status="${status}"}`, 0);
    }

    for (const name of [
      'duplicates',
      'retries',
      'lock_conflicts',
      'dlq_messages',
      'outbox_retries',
      'reconciliation_mismatches',
    ]) {
      this.counters.set(`wagering_${name}_total`, 0);
    }

    this.counters.set('wagering_processing_seconds_sum', 0);
    this.counters.set('wagering_processing_seconds_count', 0);
  }

  increment(name: string, labels = '', value = 1): void {
    const key = labels ? `${name}{${labels}}` : name;

    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  render(): string {
    return [...this.counters].map(([name, count]) => `${name} ${count}\n`).join('');
  }

  gauge(name: string, value: number): void {
    this.counters.set(name, value);
  }

  remove(name: string): void {
    this.counters.delete(name);
  }
}
