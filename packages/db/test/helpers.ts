import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { afterAll } from 'vitest';
import { createDb, type AppRole, type Db } from '../src/index.ts';

const opened: Db[] = [];

afterAll(async () => {
  await Promise.all(opened.map((db) => db.destroy()));
});

/** Pool for an application role (PG* env from the throwaway harness). */
export function openAs(role: AppRole, max = 3): Db {
  const db = createDb(role, { max });
  opened.push(db);
  return db;
}

/** Superuser pool: seeding and verification only (bypasses RLS). */
export function openSuperuser(): Db {
  const db: Db = new Kysely({ dialect: new PostgresDialect({ pool: new pg.Pool({ user: 'postgres', max: 2 }) }) });
  opened.push(db);
  return db;
}
