import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CreateWallet } from '../application/create-wallet';
import { FinancialQueries } from '../infrastructure/database/financial-queries';
import { money, object, pageLimit, text, uuid } from '../application/input-validation';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(CreateWallet) private readonly createWallet: CreateWallet,
    @Inject(FinancialQueries) private readonly queries: FinancialQueries,
  ) {}

  @Post()
  async create(@Body() body: unknown, @Headers('x-correlation-id') correlation: unknown) {
    const parsed = object(body);
    const correlationId =
      correlation === undefined ? randomUUID() : text(correlation, 'CORRELATION_ID');
    const wallet = await this.createWallet.execute(
      uuid(parsed.playerId, 'PLAYER_ID'),
      money(parsed.initialBalance),
      { correlationId },
    );

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  @Get(':walletId')
  get(@Param('walletId') walletId: string) {
    return this.queries.wallet(uuid(walletId, 'WALLET_ID'));
  }

  @Get(':walletId/ledger')
  ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ) {
    const parsedCursor = cursor === undefined ? undefined : text(cursor, 'CURSOR');

    return this.queries.ledger(uuid(walletId, 'WALLET_ID'), parsedCursor, pageLimit(limit));
  }

  @Post(':walletId/reconciliation')
  @HttpCode(200)
  reconcile(
    @Param('walletId') walletId: string,
    @Headers('x-correlation-id') correlation: unknown,
  ) {
    const correlationId =
      correlation === undefined ? randomUUID() : text(correlation, 'CORRELATION_ID');

    return this.queries.reconcile(uuid(walletId, 'WALLET_ID'), correlationId);
  }
}
