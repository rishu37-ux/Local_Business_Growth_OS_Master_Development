// Runs the reviewed SQL files in packages/db/migrations with Kysely's Migrator
// (ADR-06). Each file is one migration, applied in name order inside the
// migrator's transaction under its advisory lock. Applied migrations are
// recorded in schema lbg_migrations.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sql, type Kysely } from 'kysely';
// Kysely 0.29 exposes the migrator from the 'kysely/migration' subpath.
import { Migrator, type Migration, type MigrationProvider, type MigrationResultSet } from 'kysely/migration';

export const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', 'migrations');

export class SqlFileMigrationProvider implements MigrationProvider {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const files = (await readdir(this.#dir)).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    const migrations: Record<string, Migration> = {};
    for (const file of files) {
      const text = await readFile(path.join(this.#dir, file), 'utf8');
      // sql.raw sends no parameters, so pg uses the simple query protocol,
      // which allows a file to contain many statements.
      migrations[file.replace(/\.sql$/, '')] = {
        up: async (db) => {
          await sql.raw(text).execute(db);
        },
      };
    }
    return migrations;
  }
}

export function createMigrator(db: Kysely<unknown>, dir: string = MIGRATIONS_DIR): Migrator {
  return new Migrator({
    db,
    provider: new SqlFileMigrationProvider(dir),
    migrationTableSchema: 'lbg_migrations',
  });
}

export async function migrateToLatest(db: Kysely<unknown>, dir?: string): Promise<MigrationResultSet> {
  await sql`create schema if not exists lbg_migrations`.execute(db);
  return createMigrator(db, dir).migrateToLatest();
}
