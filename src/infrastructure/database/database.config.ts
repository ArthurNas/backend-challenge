import { Migrator } from '@mikro-orm/migrations';
import { defineConfig } from '@mikro-orm/postgresql';
import { databaseEntities } from './entities';
import { Migration202611110001 } from './migrations/Migration202611110001';
import { Migration202611110002 } from './migrations/Migration202611110002';
import { Migration202611110003 } from './migrations/Migration202611110003';
import { Migration202611110004 } from './migrations/Migration202611110004';

export const latestMigrationName = Migration202611110004.name;

export function databaseConfig(clientUrl = process.env.DATABASE_URL) {
  if (!clientUrl) throw new Error('DATABASE_URL is required');

  const url = new URL(clientUrl);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }

  return defineConfig({
    clientUrl,
    entities: databaseEntities,
    extensions: [Migrator],
    pool: { min: 0, max: 10, acquireTimeoutMillis: 5000 },
    driverOptions: { connection: { connectionTimeoutMillis: 5000 } },
    debug: false,
    migrations: {
      migrationsList: [
        Migration202611110001,
        Migration202611110002,
        Migration202611110003,
        Migration202611110004,
      ],
      transactional: true,
      allOrNothing: true,
      snapshot: false,
    },
  });
}
