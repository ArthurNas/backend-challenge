import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  Message,
  DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { SqsGateway } from '../../src/infrastructure/messaging/sqs-gateway';
import { SqsConfig } from '../../src/infrastructure/messaging/sqs.config';

export class TestSqs {
  readonly config: SqsConfig;
  readonly client: SQSClient;
  readonly gateway: SqsGateway;
  private readonly urls: string[] = [];

  constructor(endpoint: string) {
    const prefix = `test-${randomUUID()}`;
    this.config = {
      endpoint,
      region: 'us-east-1',
      queues: {
        commands: `${prefix}-commands.fifo`,
        deadLetters: `${prefix}-dlq.fifo`,
        events: `${prefix}-events.fifo`,
      },
    };
    this.client = new SQSClient({
      endpoint,
      region: 'us-east-1',
      maxAttempts: 1,
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    this.gateway = new SqsGateway(this.config);
  }

  async start(): Promise<void> {
    const dlq = await this.create(this.config.queues.deadLetters);
    const attributes = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: dlq, AttributeNames: ['QueueArn'] }),
    );
    await this.create(this.config.queues.commands, {
      VisibilityTimeout: '60',
      RedrivePolicy: JSON.stringify({
        deadLetterTargetArn: attributes.Attributes?.QueueArn,
        maxReceiveCount: '5',
      }),
    });
    await this.create(this.config.queues.events);
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      this.urls.map((QueueUrl) => this.client.send(new DeleteQueueCommand({ QueueUrl }))),
    );
    this.gateway.close();
    this.client.destroy();
  }

  async send(body: unknown, walletId: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.gateway.queueUrl(this.config.queues.commands),
        MessageBody: typeof body === 'string' ? body : JSON.stringify(body),
        MessageGroupId: walletId,
        MessageDeduplicationId: randomUUID(),
      }),
    );
  }

  async receive(queue: string, visibility = 1): Promise<Message | undefined> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: await this.gateway.queueUrl(queue),
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 1,
        VisibilityTimeout: visibility,
        MessageAttributeNames: ['All'],
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );
    return result.Messages?.[0];
  }

  async delete(queue: string, message: Message): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.gateway.queueUrl(queue),
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async create(name: string, extra: Record<string, string> = {}): Promise<string> {
    const result = await this.client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: 'true', ...extra } }),
    );
    if (!result.QueueUrl) throw new Error('Missing queue URL');
    this.urls.push(result.QueueUrl);
    return result.QueueUrl;
  }
}
