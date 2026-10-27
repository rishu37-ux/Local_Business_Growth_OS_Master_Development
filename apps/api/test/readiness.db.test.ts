import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@lbgos/db';
import { testApp } from './helpers.ts';

const db = createDb('lbgos_app', { max: 1 });
afterAll(async () => {
  await db.destroy();
});

describe('/readyz against a real database', () => {
  it('is ready when PostgreSQL answers as the tenant role', async () => {
    const { app } = testApp({
      database: async () => {
        await sql`select 1`.execute(db);
      },
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
    await app.close();
  });
});
