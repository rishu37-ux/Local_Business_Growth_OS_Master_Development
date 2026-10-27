import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { isValidImei } from '@lbgos/domain';
import vectors from '../../domain/test/vectors/imei.json' with { type: 'json' };
import { migrateToLatest } from '../src/index.ts';
import { openSuperuser } from './helpers.ts';

describe('migrations', () => {
  it('re-running against an up-to-date database applies nothing', async () => {
    const owner = new Kysely<unknown>({
      dialect: new PostgresDialect({ pool: new pg.Pool({ user: 'lbgos_owner', max: 1 }) }),
    });
    try {
      const { error, results } = await migrateToLatest(owner);
      expect(error).toBeUndefined();
      expect(results).toEqual([]);
    } finally {
      await owner.destroy();
    }
  });

  it('records every migration file as applied', async () => {
    const { rows } = await sql<{
      name: string;
    }>`select name from lbg_migrations.kysely_migration order by name`.execute(openSuperuser());
    expect(rows.map((r) => r.name)).toEqual([
      '0001_foundation',
      '0002_auth_schema',
      '0003_auth_tables',
      '0004_user_profiles',
      '0005_lifecycle',
      '0006_onboarding',
      '0007_catalogue',
      '0008_purchasing_stock',
    ]);
  });
});

describe('IMEI parity between @lbgos/domain and lbg.is_valid_imei()', () => {
  it.each([...vectors.valid, ...vectors.invalid])('agrees on %j', async (imei) => {
    const { rows } = await sql<{ ok: boolean | null }>`select lbg.is_valid_imei(${imei}) as ok`.execute(
      openSuperuser(),
    );
    expect(rows[0]?.ok ?? false).toBe(isValidImei(imei));
  });
});
