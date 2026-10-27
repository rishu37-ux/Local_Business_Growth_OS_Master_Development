// Transaction-local tenant context (ADR-07, D-004, threat T26). Every tenant
// unit of work is one transaction whose first statement sets app.business_id
// and app.user_id with set_config(..., is_local => true), so the values vanish
// at COMMIT/ROLLBACK and can never leak to the next user of a pooled
// connection. Request handlers never receive raw pool connections.
import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';

export interface TenantContext {
  readonly businessId: string;
  readonly userId: string;
}

// Typed table interfaces are generated from the migrated schema in a later
// increment; until then queries are untyped at the table level.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = Kysely<any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Trx = Transaction<any>;

/** The database roles the application connects as (bootstrap.sql). */
export type AppRole = 'lbgos_app' | 'lbgos_platform' | 'lbgos_auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export interface PoolOptions {
  /** postgres:// URL; when omitted, libpq PG* environment variables are used. */
  readonly connectionString?: string;
  readonly max?: number;
}

export function createDb(role: AppRole, options: PoolOptions = {}): Db {
  const pool = new pg.Pool(
    options.connectionString
      ? { connectionString: options.connectionString, max: options.max ?? 10 }
      : { user: role, max: options.max ?? 10 },
  );
  return new Kysely({ dialect: new PostgresDialect({ pool }) });
}

export async function withTenant<T>(db: Db, ctx: TenantContext, work: (trx: Trx) => Promise<T>): Promise<T> {
  // Context comes from the authenticated session; validate anyway so a
  // malformed value fails here instead of reaching the database.
  if (!isUuid(ctx.businessId) || !isUuid(ctx.userId)) {
    throw new Error('invalid tenant context');
  }
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.business_id', ${ctx.businessId}, true),
                     set_config('app.user_id', ${ctx.userId}, true)`.execute(trx);
    return work(trx);
  });
}

/** Platform-admin or pre-tenant work: one transaction, no tenant context. */
export async function withoutTenant<T>(db: Db, work: (trx: Trx) => Promise<T>): Promise<T> {
  return db.transaction().execute(work);
}
