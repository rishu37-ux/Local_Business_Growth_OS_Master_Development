// Usage: node src/migrate-cli.ts
// Connects as the migration/owner role: LBGOS_MIGRATION_DATABASE_URL if set,
// otherwise libpq PG* environment variables with user lbgos_owner.
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { migrateToLatest } from './migrate.ts';

const url = process.env['LBGOS_MIGRATION_DATABASE_URL'];
const pool = new pg.Pool(url ? { connectionString: url, max: 1 } : { user: 'lbgos_owner', max: 1 });
const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool }) });

try {
  const { error, results = [] } = await migrateToLatest(db);
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.migrationName}`);
  if (results.length === 0) console.log('no pending migrations');
  if (error) {
    console.error('migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
} finally {
  await db.destroy();
}
