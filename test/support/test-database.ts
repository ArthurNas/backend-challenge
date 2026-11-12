import { randomUUID } from 'node:crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../../src/infrastructure/database/database.config';

export class TestDatabase {
  readonly name = `wagering_test_${randomUUID().replaceAll('-', '')}`;
  orm!: MikroORM;
  url!: string;
  private admin: MikroORM | undefined;
  private created = false;

  async start(parentUrl: string): Promise<void> {
    this.admin = await MikroORM.init(databaseConfig(parentUrl));
    await this.admin.em.getConnection().execute(`create database "${this.name}"`);
    this.created = true;
    const url = new URL(parentUrl);
    url.pathname = `/${this.name}`;
    this.url = url.toString();
    this.orm = await MikroORM.init(databaseConfig(this.url));
    await this.orm.migrator.up();
  }

  async close(): Promise<void> {
    if (this.orm) await this.orm.close(true);
    if (this.created) await this.admin?.em.getConnection().execute(`drop database "${this.name}"`);
    await this.admin?.close(true);
  }
}
