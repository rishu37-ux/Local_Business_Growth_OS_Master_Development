// Integration secrets (increment 7.2: FR-HUB-3, ADR-13, D-055). Write-only
// for people: the API returns metadata and a 4-character hint, never the
// value. Only `readSecretValue` (secrets role, for adapters) opens a secret.
// Audit events carry IDs, purpose and label, never the value.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { withTenant, type Db, type TenantContext } from '@lbgos/db';
import { recordTenantEvent } from '../audit/index.ts';
import { openSecret, rewrapSecret, sealSecret, secretAad, secretHint, type Keyring } from './crypto.ts';

export {
  KeyringError,
  openSecret,
  parseKeyring,
  rewrapSecret,
  sealSecret,
  secretAad,
  secretHint,
  type Keyring,
  type SealedSecret,
} from './crypto.ts';

export class SecretError extends Error {
  readonly code: 'NOT_FOUND' | 'REVOKED' | 'STORE_NOT_CONFIGURED';

  constructor(code: SecretError['code'], message: string) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

export interface SecretInfo {
  readonly id: string;
  readonly purpose: string;
  readonly label: string;
  /** Last 4 characters of a long value, or null. */
  readonly hint: string | null;
  readonly replacesSecretId: string | null;
  readonly createdAt: string;
  readonly rewrappedAt: string | null;
  readonly revokedAt: string | null;
}

interface InfoRow {
  id: string;
  purpose: string;
  label: string;
  hint: string | null;
  replaces_secret_id: string | null;
  created_at: Date;
  rewrapped_at: Date | null;
  revoked_at: Date | null;
}

const INFO = sql`id, purpose, label, hint, replaces_secret_id, created_at, rewrapped_at, revoked_at`;
const toInfo = (r: InfoRow): SecretInfo => ({
  id: r.id,
  purpose: r.purpose,
  label: r.label,
  hint: r.hint,
  replacesSecretId: r.replaces_secret_id,
  createdAt: r.created_at.toISOString(),
  rewrappedAt: r.rewrapped_at?.toISOString() ?? null,
  revokedAt: r.revoked_at?.toISOString() ?? null,
});

const requireKeyring = (keyring: Keyring | null): Keyring => {
  if (!keyring) throw new SecretError('STORE_NOT_CONFIGURED', 'The secret store is not configured on this server.');
  return keyring;
};

export interface SecretInput {
  readonly purpose: string;
  readonly label: string;
  readonly value: string;
}

/** Seals and stores a new secret; with `replaces`, the old one is revoked in the same transaction (rotation). */
export async function storeSecret(
  appDb: Db,
  keyring: Keyring | null,
  ctx: TenantContext,
  input: SecretInput,
  options: { readonly replaces?: string; readonly requestId?: string } = {},
): Promise<SecretInfo> {
  const ring = requireKeyring(keyring);
  return withTenant(appDb, ctx, async (trx) => {
    if (options.replaces) {
      const { rows } = await sql<{ revoked: boolean; purpose: string }>`
        select revoked_at is not null as revoked, purpose from lbg.integration_secrets
         where business_id = ${ctx.businessId} and id = ${options.replaces}`.execute(trx);
      const old = rows[0];
      if (!old) throw new SecretError('NOT_FOUND', 'Secret not found.');
      if (old.revoked) throw new SecretError('REVOKED', 'This secret was revoked; store a new one instead.');
    }
    const id = randomUUID();
    const sealed = sealSecret(ring, input.value, secretAad(ctx.businessId, id, input.purpose));
    const { rows } = await sql<InfoRow>`
      insert into lbg.integration_secrets (business_id, id, purpose, label, hint, kek_version, wrapped_key, payload,
                                           replaces_secret_id, created_by)
      values (${ctx.businessId}, ${id}, ${input.purpose}, ${input.label.trim()}, ${secretHint(input.value)},
              ${sealed.kekVersion}, ${sealed.wrappedKey}, ${sealed.payload}, ${options.replaces ?? null}, ${ctx.userId})
      returning ${INFO}`.execute(trx);
    if (options.replaces) {
      await sql`update lbg.integration_secrets
                   set revoked_at = now(), revoked_by = ${ctx.userId}, wrapped_key = null, payload = null
                 where business_id = ${ctx.businessId} and id = ${options.replaces}`.execute(trx);
    }
    const row = rows[0];
    if (!row) throw new Error('secret insert returned nothing');
    await recordTenantEvent(trx, ctx, {
      action: options.replaces ? 'secret.rotate' : 'secret.store',
      targetType: 'secret',
      targetId: id,
      metadata: {
        purpose: input.purpose,
        label: input.label.trim(),
        ...(options.replaces ? { replaces: options.replaces } : {}),
      },
      ...(options.requestId ? { requestId: options.requestId } : {}),
    });
    return toInfo(row);
  });
}

/** Metadata only; viewing is audited (FR-HUB-3 AC4). */
export async function listSecrets(appDb: Db, ctx: TenantContext, requestId?: string): Promise<SecretInfo[]> {
  return withTenant(appDb, ctx, async (trx) => {
    const { rows } = await sql<InfoRow>`
      select ${INFO} from lbg.integration_secrets where business_id = ${ctx.businessId}
       order by created_at desc, id limit 500`.execute(trx);
    await recordTenantEvent(trx, ctx, {
      action: 'secret.list',
      targetType: 'business',
      targetId: ctx.businessId,
      metadata: { count: rows.length },
      ...(requestId ? { requestId } : {}),
    });
    return rows.map(toInfo);
  });
}

/** Revokes a secret and destroys its sealed material. */
export async function revokeSecret(appDb: Db, ctx: TenantContext, id: string, requestId?: string): Promise<SecretInfo> {
  return withTenant(appDb, ctx, async (trx) => {
    const { rows } = await sql<InfoRow>`
      update lbg.integration_secrets
         set revoked_at = now(), revoked_by = ${ctx.userId}, wrapped_key = null, payload = null
       where business_id = ${ctx.businessId} and id = ${id} and revoked_at is null
      returning ${INFO}`.execute(trx);
    const row = rows[0];
    if (!row) {
      const exists = await sql`select 1 from lbg.integration_secrets
                                where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
      throw exists.rows.length > 0
        ? new SecretError('REVOKED', 'This secret is already revoked.')
        : new SecretError('NOT_FOUND', 'Secret not found.');
    }
    await recordTenantEvent(trx, ctx, {
      action: 'secret.revoke',
      targetType: 'secret',
      targetId: id,
      metadata: { purpose: row.purpose, label: row.label },
      ...(requestId ? { requestId } : {}),
    });
    return toInfo(row);
  });
}

/**
 * The plaintext value, for an adapter that is about to call its provider.
 * Uses the secrets role; never pass the result to a log, an error, an audit
 * event or a response.
 */
export async function readSecretValue(
  secretsDb: Db,
  keyring: Keyring | null,
  ctx: TenantContext,
  id: string,
): Promise<string> {
  const ring = requireKeyring(keyring);
  const row = await withTenant(secretsDb, ctx, async (trx) => {
    const { rows } = await sql<{
      purpose: string;
      kek_version: string | null;
      wrapped_key: Buffer | null;
      payload: Buffer | null;
      revoked_at: Date | null;
    }>`select purpose, kek_version, wrapped_key, payload, revoked_at from lbg.integration_secrets
        where business_id = ${ctx.businessId} and id = ${id}`.execute(trx);
    return rows[0];
  });
  if (!row) throw new SecretError('NOT_FOUND', 'Secret not found.');
  if (row.revoked_at || !row.kek_version || !row.wrapped_key || !row.payload) {
    throw new SecretError('REVOKED', 'This secret was revoked.');
  }
  return openSecret(
    ring,
    { kekVersion: row.kek_version, wrappedKey: row.wrapped_key, payload: row.payload },
    secretAad(ctx.businessId, id, row.purpose),
  );
}

/** KEK rotation: re-seals every live data key of the business under the current KEK (secrets role). */
export async function rewrapSecrets(secretsDb: Db, keyring: Keyring | null, ctx: TenantContext): Promise<number> {
  const ring = requireKeyring(keyring);
  return withTenant(secretsDb, ctx, async (trx) => {
    const { rows } = await sql<{
      id: string;
      purpose: string;
      kek_version: string;
      wrapped_key: Buffer;
      payload: Buffer;
    }>`
      select id, purpose, kek_version, wrapped_key, payload from lbg.integration_secrets
       where business_id = ${ctx.businessId} and revoked_at is null and kek_version <> ${ring.current}
       for update`.execute(trx);
    for (const r of rows) {
      const next = rewrapSecret(
        ring,
        { kekVersion: r.kek_version, wrappedKey: r.wrapped_key, payload: r.payload },
        secretAad(ctx.businessId, r.id, r.purpose),
      );
      await sql`update lbg.integration_secrets
                   set kek_version = ${next.kekVersion}, wrapped_key = ${next.wrappedKey}, rewrapped_at = now()
                 where business_id = ${ctx.businessId} and id = ${r.id}`.execute(trx);
    }
    return rows.length;
  });
}

/** Rotation: a new value for an existing secret (same purpose and label); the old one is revoked. */
export async function rotateSecret(
  appDb: Db,
  keyring: Keyring | null,
  ctx: TenantContext,
  id: string,
  value: string,
  requestId?: string,
): Promise<SecretInfo> {
  const old = await withTenant(appDb, ctx, async (trx) => {
    const { rows } = await sql<{ purpose: string; label: string }>`
      select purpose, label from lbg.integration_secrets where business_id = ${ctx.businessId} and id = ${id}`.execute(
      trx,
    );
    return rows[0];
  });
  if (!old) throw new SecretError('NOT_FOUND', 'Secret not found.');
  return storeSecret(
    appDb,
    keyring,
    ctx,
    { purpose: old.purpose, label: old.label, value },
    { replaces: id, ...(requestId ? { requestId } : {}) },
  );
}
