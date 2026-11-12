import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';
import { SqsConfig } from './sqs.config';

export class SqsGateway {
  private readonly client: SQSClient;
  private readonly urls = new Map<string, string>();

  constructor(
    readonly config: SqsConfig,
    readonly visibilitySeconds = 60,
  ) {
    this.client = new SQSClient({
      region: config.region,
      ...(config.endpoint
        ? {
            endpoint: config.endpoint,
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
            },
          }
        : {}),
      maxAttempts: 2,
      requestHandler: { connectionTimeout: 2000, requestTimeout: 15000 },
    });
  }

  async queueUrl(name: string): Promise<string> {
    const cached = this.urls.get(name);
    if (cached) return cached;

    const result = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
    if (!result.QueueUrl) throw new Error('SQS did not return a queue URL');

    this.urls.set(name, result.QueueUrl);

    return result.QueueUrl;
  }

  async check(): Promise<void> {
    await Promise.all(
      Object.values(this.config.queues).map(async (name) => {
        const url = await this.queueUrl(name);

        await this.client.send(
          new GetQueueAttributesCommand({ QueueUrl: url, AttributeNames: ['QueueArn'] }),
        );
      }),
    );
  }

  async receive(signal?: AbortSignal): Promise<Message | undefined> {
    if (signal?.aborted) return undefined;

    const url = await this.queueUrl(this.config.queues.commands);
    if (signal?.aborted) return undefined;
    // Não abortar um long poll já enviado: o broker pode entregar uma mensagem
    // enquanto a conexão é fechada, deixando seu ReceiptHandle desconhecido.
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
        VisibilityTimeout: this.visibilitySeconds,
        MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
      }),
    );

    return result.Messages?.[0];
  }

  async ack(receipt: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: await this.queueUrl(this.config.queues.commands),
        ReceiptHandle: receipt,
      }),
    );
  }

  async visibility(receipt: string, seconds: number, signal?: AbortSignal): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: await this.queueUrl(this.config.queues.commands),
        ReceiptHandle: receipt,
        VisibilityTimeout: seconds,
      }),
      signal ? { abortSignal: signal } : {},
    );
  }

  async publish(
    eventId: string,
    walletId: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(this.config.queues.events),
        MessageBody: JSON.stringify(payload),
        MessageGroupId: walletId,
        MessageDeduplicationId: eventId,
      }),
    );
  }

  async deadLetter(message: Message, code: string): Promise<void> {
    const body = message.Body ?? '';
    const digest = createHash('sha256').update(body).digest('hex');

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(this.config.queues.deadLetters),
        MessageBody: body || '{}',
        MessageGroupId: message.Attributes?.MessageGroupId ?? 'invalid-message',
        MessageDeduplicationId: digest,
        MessageAttributes: { FailureCode: { DataType: 'String', StringValue: code } },
      }),
    );
  }

  close(): void {
    this.client.destroy();
  }

  async deadLetterDepth(): Promise<number> {
    const result = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: await this.queueUrl(this.config.queues.deadLetters),
        AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
      }),
    );

    return (
      Number(result.Attributes?.ApproximateNumberOfMessages ?? 0) +
      Number(result.Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0)
    );
  }

  async request(
    payload: Record<string, unknown>,
    walletId: string,
    messageId: string,
  ): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(this.config.queues.commands),
        MessageBody: JSON.stringify(payload),
        MessageGroupId: walletId,
        MessageDeduplicationId: createHash('sha256').update(messageId).digest('hex'),
      }),
    );
  }

  onApplicationShutdown(): void {
    this.close();
  }
}
