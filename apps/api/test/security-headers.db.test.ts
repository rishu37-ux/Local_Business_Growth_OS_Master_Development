// Increment 9.4 AC3: the security headers (NFR-17) are present on every kind of
// response the app sends — API JSON, the HTML app shell, a static asset, a
// file download, and each error class (400, 401, 404, 413) — and request size
// limits hold. Synthetic data only.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshIp, startHarness, type Harness } from './auth-harness.ts';
import { activeShop, get, resetFixture, type Shop } from './shop-fixture.ts';

const WEB_ROOT = path.resolve(import.meta.dirname, '../../web/dist');
let h: Harness;
let shop: Shop;

beforeAll(async () => {
  h = await startHarness({ webRoot: WEB_ROOT });
  resetFixture();
  shop = await activeShop(h, 'headers');
}, 120_000);
afterAll(async () => {
  await h.close();
});

function expectSecurityHeaders(label: string, headers: Record<string, unknown>): void {
  const csp = String(headers['content-security-policy']);
  expect({ label, csp: csp.includes("default-src 'self'") || csp.includes("default-src 'none'") }).toEqual({
    label,
    csp: true,
  });
  expect({ label, frames: csp.includes("frame-ancestors 'none'") || csp.includes("default-src 'none'") }).toEqual({
    label,
    frames: true,
  });
  expect({ label, hsts: headers['strict-transport-security'] }).toEqual({
    label,
    hsts: 'max-age=31536000; includeSubDomains',
  });
  expect({ label, nosniff: headers['x-content-type-options'] }).toEqual({ label, nosniff: 'nosniff' });
  expect({ label, referrer: headers['referrer-policy'] }).toEqual({
    label,
    referrer: 'strict-origin-when-cross-origin',
  });
  expect({ label, requestId: typeof headers['x-request-id'] }).toEqual({ label, requestId: 'string' });
}

describe('security headers on every response type (NFR-17, 9.4 AC3)', () => {
  it('API JSON, HTML shell, asset, CSV download and errors all carry the headers', async () => {
    const asset = readdirSync(path.join(WEB_ROOT, 'assets')).find((f) => f.endsWith('.js')) ?? 'missing.js';
    const cases: [string, number, Promise<{ statusCode: number; headers: Record<string, unknown> }>][] = [
      ['API JSON', 200, get(h, shop.base, shop.owner)],
      ['HTML app shell', 200, h.app.inject({ method: 'GET', url: '/sign-in' })],
      ['static asset', 200, h.app.inject({ method: 'GET', url: `/assets/${asset}` })],
      [
        'CSV download',
        200,
        get(h, `${shop.base}/reports/sales-summary/export?period=month&date=2026-10-15&format=csv`, shop.owner),
      ],
      ['400 validation', 400, get(h, `${shop.base}/reports/sales-summary?period=decade`, shop.owner)],
      ['401 signed out', 401, h.app.inject({ method: 'GET', url: shop.base, remoteAddress: freshIp() })],
      ['404 API', 404, h.app.inject({ method: 'GET', url: '/api/nothing-here' })],
      [
        '413 body too large',
        413,
        h.app.inject({
          method: 'POST',
          url: `${shop.base}/customers`,
          remoteAddress: freshIp(),
          headers: {
            'content-type': 'application/json',
            origin: h.origin,
            cookie: Object.entries(shop.owner)
              .map(([k, v]) => `${k}=${v}`)
              .join('; '),
          },
          payload: JSON.stringify({ name: 'x'.repeat(1_100_000) }),
        }),
      ],
    ];
    for (const [label, status, pending] of cases) {
      const res = await pending;
      expect({ label, status: res.statusCode }).toEqual({ label, status });
      expectSecurityHeaders(label, res.headers);
    }
  });

  it('API responses are never cached; downloads are attachments', async () => {
    const json = await get(h, shop.base, shop.owner);
    expect(json.headers['cache-control']).toBe('no-store');
    const csv = await get(
      h,
      `${shop.base}/reports/sales-summary/export?period=month&date=2026-10-15&format=csv`,
      shop.owner,
    );
    expect(String(csv.headers['content-disposition'])).toMatch(/^attachment;/);
    expect(csv.headers['cache-control']).toBe('no-store');
  });
});
