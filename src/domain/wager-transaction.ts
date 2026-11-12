import { DomainError, type FailureCode } from './domain-error';
import { Money } from './money';
import { LedgerDirection } from './wallet-ledger-entry';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(props: CreateWagerTransactionProps & { createdAt: Date }): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) throw new DomainError('INTERNAL_OPERATION');

    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new DomainError('INVALID_OPERATION');
    }

    const transaction = WagerTransaction.rehydrate({
      ...props,
      status: WagerTransactionStatus.Pending,
    });

    transaction.assertReferenceContract();
    transaction.assertAmount();

    return transaction;
  }

  static opening(props: CreateWagerTransactionProps & { createdAt: Date }): WagerTransaction {
    if (
      props.kind !== WagerTransactionKind.Opening ||
      !props.money.isPositive() ||
      props.referenceExternalTransactionId !== undefined
    ) {
      throw new DomainError('INVALID_OPERATION');
    }

    return WagerTransaction.rehydrate({ ...props, status: WagerTransactionStatus.Pending });
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt && new Date(state.processedAt),
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get processedAt(): Date | undefined {
    if (!this._processedAt) return undefined;

    return new Date(this._processedAt);
  }

  isTerminal(): boolean {
    return (
      this.status === WagerTransactionStatus.Processed ||
      this.status === WagerTransactionStatus.Rejected ||
      this.status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return this.kind === WagerTransactionKind.Refund || this.kind === WagerTransactionKind.Rollback;
  }

  matchesPayload(hash: string): boolean {
    return this.payloadHash === hash;
  }

  assertReplay(hash: string): void {
    if (!this.matchesPayload(hash)) throw new DomainError('IDEMPOTENCY_CONFLICT');
  }

  markProcessed(referenceId: string | undefined, at: Date): void {
    this.assertMutable();
    if (
      (this.requiresReference() || this.referenceExternalTransactionId !== undefined) &&
      !referenceId
    ) {
      throw new DomainError('REFERENCE_REQUIRED');
    }

    if (referenceId !== undefined) this._referenceTransactionId = referenceId;

    this._processedAt = new Date(at);
    this._status = WagerTransactionStatus.Processed;
  }

  markPendingReference(): void {
    this.assertMutable();
    if (!this.referenceExternalTransactionId) throw new DomainError('REFERENCE_REQUIRED');

    this._status = WagerTransactionStatus.PendingReference;
  }

  reject(code: FailureCode): void {
    this.assertMutable();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Rejected;
  }

  fail(code: FailureCode): void {
    this.assertMutable();
    this._failureCode = code;
    this._status = WagerTransactionStatus.Failed;
  }

  /** A consulta de reversão prévia precisa ocorrer sob a transação/lock no banco. */
  validateReference(reference: WagerTransaction, alreadyReversed = false): void {
    if (
      reference.providerId !== this.providerId ||
      reference.externalTransactionId !== this.referenceExternalTransactionId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency ||
      reference.id === this.id
    ) {
      throw new DomainError('REFERENCE_MISMATCH');
    }

    if (!this.allowedReferenceKinds().includes(reference.kind)) {
      throw new DomainError('INVALID_REFERENCE_KIND');
    }

    if (reference.status !== WagerTransactionStatus.Processed) {
      throw new DomainError('REFERENCE_NOT_PROCESSED');
    }

    if (this.requiresReference() && !this.money.equals(reference.money)) {
      throw new DomainError('INVALID_AMOUNT');
    }

    if (this.requiresReference() && alreadyReversed) throw new DomainError('ALREADY_REVERSED');
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection | undefined {
    if (this.kind === WagerTransactionKind.Loss) return undefined;

    this.assertResolvedReference(reference);
    if (this.kind === WagerTransactionKind.Bet) return LedgerDirection.Debit;

    if (
      this.kind === WagerTransactionKind.Rollback &&
      reference?.kind !== WagerTransactionKind.Bet
    ) {
      return LedgerDirection.Debit;
    }

    return LedgerDirection.Credit;
  }

  private assertReferenceContract(): void {
    if (this.requiresReference() && !this.referenceExternalTransactionId) {
      throw new DomainError('REFERENCE_REQUIRED');
    }

    const forbidsReference =
      this.kind === WagerTransactionKind.Bet || this.kind === WagerTransactionKind.Loss;
    if (forbidsReference && this.referenceExternalTransactionId !== undefined) {
      throw new DomainError('INVALID_REFERENCE_KIND');
    }
  }

  private assertAmount(): void {
    if (this.kind === WagerTransactionKind.Loss && this.money.isZero()) return;

    if (this.kind !== WagerTransactionKind.Loss && this.money.isPositive()) return;

    throw new DomainError('INVALID_AMOUNT');
  }

  private assertResolvedReference(reference?: WagerTransaction): void {
    if (!this.requiresReference() && this.referenceExternalTransactionId === undefined) return;

    if (!reference) throw new DomainError('REFERENCE_REQUIRED');

    this.validateReference(reference);
  }

  private allowedReferenceKinds(): WagerTransactionKind[] {
    if (this.kind === WagerTransactionKind.Rollback) {
      return [WagerTransactionKind.Bet, WagerTransactionKind.Win, WagerTransactionKind.Refund];
    }

    if (this.kind === WagerTransactionKind.Win || this.kind === WagerTransactionKind.Refund) {
      return [WagerTransactionKind.Bet];
    }

    return [];
  }

  private assertMutable(): void {
    if (this.isTerminal()) throw new DomainError('INVALID_TRANSACTION_STATE');
  }
}
