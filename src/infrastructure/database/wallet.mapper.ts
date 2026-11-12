import { Money } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import { WalletRecord } from './entities';

export class WalletMapper {
  static toDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.from({ amount: record.balance, currency: record.currency }),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  static toRecord(wallet: Wallet): WalletRecord {
    const record = new WalletRecord();

    record.id = wallet.id;
    record.playerId = wallet.playerId;
    record.currency = wallet.currency;
    record.balance = wallet.balance.toString();
    record.version = wallet.version;
    record.createdAt = wallet.createdAt;
    record.updatedAt = wallet.updatedAt;

    return record;
  }
}
