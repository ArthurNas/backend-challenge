import { LockMode } from '@mikro-orm/core';
import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { Wallet } from '../../domain/wallet';
import { WalletRecord } from './entities';
import { WalletMapper } from './wallet.mapper';

export class PostgresWalletRepository {
  constructor(private readonly orm: MikroORM) {}

  async findById(walletId: string): Promise<Wallet | undefined> {
    const record = await this.orm.em.fork().findOne(WalletRecord, { id: walletId });
    if (!record) return undefined;

    return WalletMapper.toDomain(record);
  }

  /** O callback deve persistir transação, ledger e eventos no mesmo EntityManager. */
  async withLockedWallet<T>(
    walletId: string,
    work: (wallet: Wallet, em: EntityManager) => Promise<T>,
  ): Promise<T> {
    return this.orm.em.fork().transactional(async (em) => {
      const record = await em.findOneOrFail(
        WalletRecord,
        { id: walletId },
        {
          lockMode: LockMode.PESSIMISTIC_WRITE,
        },
      );
      const wallet = WalletMapper.toDomain(record);
      const result = await work(wallet, em);

      em.assign(record, WalletMapper.toRecord(wallet));

      return result;
    });
  }
}
