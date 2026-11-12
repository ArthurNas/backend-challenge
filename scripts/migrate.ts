import { MikroORM } from '@mikro-orm/postgresql';
import { databaseConfig } from '../src/infrastructure/database/database.config';

const command = process.argv[2];

if (command !== 'up' && command !== 'down') {
  throw new Error('Usage: bun scripts/migrate.ts up|down');
}

const orm = await MikroORM.init(databaseConfig());

try {
  const migrations = await orm.migrator[command]();

  console.log(
    JSON.stringify({ command, migrations: migrations.map((migration) => migration.name) }),
  );
} finally {
  await orm.close(true);
}
