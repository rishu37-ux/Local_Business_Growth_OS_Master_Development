import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { testApp } from './helpers.ts';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('security headers (3.4 AC2, NFR-17)', () => {
  it('sets CSP, HSTS, nosniff, referrer policy, frame protection and no-store', async () => {
    ({ app } = testApp());
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sets the same headers on 404 responses', async () => {
    ({ app } = testApp());
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('health (3.4 AC3)', () => {
  it('/healthz is ok', async () => {
    ({ app } = testApp());
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('/readyz is 503 without details when the database check fails', async () => {
    let logs;
    ({ app, logs } = testApp({ database: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')) }));
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toContain('ECONNREFUSED');
    expect(logs.text).toContain('readiness check failed');
  });
});

describe('request IDs and logging (3.4 AC4)', () => {
  it('echoes a well-formed upstream request ID and replaces a malformed one', async () => {
    ({ app } = testApp());
    const good = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'edge-1234abcd' } });
    expect(good.headers['x-request-id']).toBe('edge-1234abcd');
    const bad = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'x\n{"forged":1}' } });
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('writes JSON logs with the request ID and redacts planted secrets', async () => {
    let logs;
    ({ app, logs } = testApp());
    app.post('/test/log', { config: { public: true } }, (request) => {
      request.log.info(
        {
          password: 'P1anted-Password!',
          apiKey: 'sk_test_planted_key_123',
          user: { token: 'planted-session-token', name: 'visible-name' },
          req: { headers: { authorization: 'Bearer planted-bearer', cookie: 'sid=planted-cookie' } },
        },
        'audit-me',
      );
      return { ok: true };
    });
    const res = await app.inject({ method: 'POST', url: '/test/log', payload: {} });
    expect(res.statusCode).toBe(200);
    const line = logs.lines.find((l) => l['msg'] === 'audit-me');
    expect(line?.['reqId']).toBe(res.headers['x-request-id']);
    for (const planted of [
      'P1anted-Password!',
      'sk_test_planted_key_123',
      'planted-session-token',
      'planted-bearer',
      'planted-cookie',
    ]) {
      expect(logs.text).not.toContain(planted);
    }
    expect(logs.text).toContain('visible-name');
    expect(logs.text).toContain('[Redacted]');
  });
});

describe('error mapping (3.4 AC5)', () => {
  const cases: [string, number, string][] = [
    ['LB001', 409, 'APPEND_ONLY'],
    ['LB002', 409, 'INVALID_TRANSITION'],
    ['LB003', 409, 'IMMUTABLE_DOCUMENT'],
    ['LB004', 422, 'TOTALS_MISMATCH'],
    ['LB005', 422, 'ALLOCATION_OUT_OF_BOUNDS'],
    ['23505', 409, 'CONFLICT'],
    ['23503', 422, 'INVALID_REFERENCE'],
    ['23514', 422, 'CONSTRAINT_VIOLATION'],
    ['42501', 403, 'FORBIDDEN'],
  ];

  it.each(cases)('maps SQLSTATE %s to %i %s without leaking internals', async (sqlstate, status, code) => {
    ({ app } = testApp());
    app.get('/test/fail', { config: { public: true } }, () => {
      throw Object.assign(new Error(`internal detail: relation lbg.payment_allocations constraint xyz (${sqlstate})`), {
        code: sqlstate,
      });
    });
    const res = await app.inject({ method: 'GET', url: '/test/fail' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toMatchObject({ error: { code, requestId: res.headers['x-request-id'] } });
    expect(res.body).not.toContain('lbg.');
    expect(res.body).not.toContain('internal detail');
  });

  it('returns a generic 500 for unexpected errors', async () => {
    let logs;
    ({ app, logs } = testApp());
    app.get('/test/boom', { config: { public: true } }, () => {
      throw new Error('stack secret: /srv/app/internal.ts');
    });
    const res = await app.inject({ method: 'GET', url: '/test/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ error: { code: 'INTERNAL' } });
    expect(res.body).not.toContain('stack secret');
    expect(logs.text).toContain('stack secret');
  });

  it('returns 400 with field issues for schema violations and rejects unknown fields', async () => {
    ({ app } = testApp());
    app.post(
      '/test/validate',
      { config: { public: true }, schema: { body: z.strictObject({ name: z.string().min(2) }) } },
      (request) => request.body,
    );
    const short = await app.inject({ method: 'POST', url: '/test/validate', payload: { name: 'x' } });
    expect(short.statusCode).toBe(400);
    expect(short.json()).toMatchObject({ error: { code: 'VALIDATION', issues: [{ path: 'name' }] } });
    const extra = await app.inject({ method: 'POST', url: '/test/validate', payload: { name: 'ok', isAdmin: true } });
    expect(extra.statusCode).toBe(400);
    const good = await app.inject({ method: 'POST', url: '/test/validate', payload: { name: 'ok' } });
    expect(good.statusCode).toBe(200);
    expect(good.json()).toEqual({ name: 'ok' });
  });
});

describe('client IP and proxies', () => {
  const probe = (a: FastifyInstance) => {
    a.get('/test/ip', { config: { public: true } }, (request) => ({ ip: request.ip }));
    return a.inject({
      method: 'GET',
      url: '/test/ip',
      remoteAddress: '10.0.0.2',
      headers: { 'x-forwarded-for': '203.0.113.9, 198.51.100.7' },
    });
  };

  it('ignores X-Forwarded-For when no proxy hops are trusted (default)', async () => {
    ({ app } = testApp());
    expect((await probe(app)).json()).toEqual({ ip: '10.0.0.2' });
  });

  it('trusts exactly the configured number of hops', async () => {
    ({ app } = testApp(undefined, { TRUST_PROXY_HOPS: '1' }));
    expect((await probe(app)).json()).toEqual({ ip: '198.51.100.7' });
    await app.close();
    ({ app } = testApp(undefined, { TRUST_PROXY_HOPS: '2' }));
    expect((await probe(app)).json()).toEqual({ ip: '203.0.113.9' });
  });
});

describe('route declarations (3.4 AC6)', () => {
  it('refuses to register a route without permission or public declaration', () => {
    ({ app } = testApp());
    expect(() => app?.get('/undeclared', () => 'x')).toThrow(/must declare config.permission or config.public/);
  });

  it('accepts a route declaring a permission', () => {
    ({ app } = testApp());
    expect(() => app?.get('/declared', { config: { permission: 'catalogue.view' } }, () => 'x')).not.toThrow();
  });
});
