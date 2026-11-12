import { BeforeApplicationShutdown, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { WagerConsumer } from '../messaging/wager-consumer';
import { OutboxPublisher } from './outbox-publisher';
import { ReferenceWorker } from './reference-worker';

export class WorkerHost implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger('Workers');
  private readonly abort = new AbortController();
  private jobs: Promise<void>[] = [];

  constructor(
    private readonly consumer: WagerConsumer,
    private readonly publisher: OutboxPublisher,
    private readonly references: ReferenceWorker,
  ) {}

  onApplicationBootstrap(): void {
    this.jobs = [
      this.loop('consumer', () => this.consumer.runOnce(this.abort.signal), 100),
      this.loop('outbox', () => this.publisher.runOnce(), 500),
      this.loop('references', () => this.references.runOnce(), 500),
    ];
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.abort.abort();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      Promise.allSettled(this.jobs).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 25000);
      }),
    ]);

    clearTimeout(timer);
    if (!drained) await this.consumer.releaseInFlight();
  }

  private async loop(name: string, work: () => Promise<boolean>, interval: number): Promise<void> {
    while (!this.abort.signal.aborted) {
      let busy = false;

      try {
        busy = await work();
      } catch (error) {
        if (!this.abort.signal.aborted)
          this.logger.warn({
            worker: name,
            code: 'WORKER_RETRY',
            error: error instanceof Error ? error.name : 'UnknownError',
          });
      }

      if (!busy) await this.pause(interval);
    }
  }

  private async pause(milliseconds: number): Promise<void> {
    if (this.abort.signal.aborted) return;

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.abort.signal.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, milliseconds);

      this.abort.signal.addEventListener('abort', finish, { once: true });
    });
  }
}
