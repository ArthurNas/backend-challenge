export interface QueueNames {
  commands: string;
  deadLetters: string;
  events: string;
}

export interface SqsConfig {
  endpoint?: string;
  region: string;
  queues: QueueNames;
}

export function sqsConfig(): SqsConfig {
  const config: SqsConfig = {
    region: process.env.AWS_REGION ?? 'us-east-1',
    queues: {
      commands: process.env.SQS_COMMAND_QUEUE ?? 'wager-transactions.fifo',
      deadLetters: process.env.SQS_DLQ ?? 'wager-transactions-dlq.fifo',
      events: process.env.SQS_EVENT_QUEUE ?? 'wager-events.fifo',
    },
  };
  if (process.env.SQS_ENDPOINT) {
    const endpoint = new URL(process.env.SQS_ENDPOINT);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Invalid SQS_ENDPOINT');

    config.endpoint = endpoint.toString();
  }

  return config;
}
