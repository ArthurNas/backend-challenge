export interface InboxState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: Omit<InboxState, 'processedAt'>): InboxMessage {
    return InboxMessage.rehydrate(props);
  }

  static rehydrate(state: InboxState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt && new Date(state.processedAt),
    );
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt);
  }

  get processedAt(): Date | undefined {
    if (!this._processedAt) return undefined;

    return new Date(this._processedAt);
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) return;

    this._processedAt = new Date(at);
  }
}
