// Parity: the domain transition table (@lbgos/domain) and the database
// trigger (lbg.businesses_status_guard) agree on all 36 status pairs.
import { BUSINESS_STATUSES, canTransition } from '@lbgos/domain';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const client = new pg.Client({ user: 'postgres' });
beforeAll(async () => {
  await client.connect();
});
afterAll(async () => {
  await client.end();
});

describe('business status transitions: domain == database', () => {
  const pairs = BUSINESS_STATUSES.flatMap((from) =>
    BUSINESS_STATUSES.filter((to) => to !== from).map((to) => [from, to] as const),
  );

  it.each(pairs)('%s -> %s', async (from, to) => {
    await client.query('begin');
    try {
      // Seed a row directly in `from` (superuser, triggers off for the seed only).
      await client.query("set local session_replication_role = 'replica'");
      const { rows } = await client.query<{ id: string }>(
        `insert into lbg.businesses (legal_name, category, status) values ('Parity (synthetic)', 'TEST', $1) returning id`,
        [from],
      );
      await client.query("set local session_replication_role = 'origin'");
      await client.query('savepoint attempt');
      let accepted = true;
      try {
        await client.query('update lbg.businesses set status = $1 where id = $2', [to, rows[0]?.id]);
      } catch (err) {
        expect((err as { code?: string }).code).toBe('LB002');
        accepted = false;
      }
      expect(accepted).toBe(canTransition(from, to));
    } finally {
      await client.query('rollback');
    }
  });
});
