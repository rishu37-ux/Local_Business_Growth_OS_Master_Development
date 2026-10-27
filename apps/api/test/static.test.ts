import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { resolveInside } from '../src/static.ts';
import { LogCapture, okReadiness } from './helpers.ts';

const root = mkdtempSync(path.join(tmpdir(), 'lbgos-web-'));
mkdirSync(path.join(root, 'assets'));
writeFileSync(path.join(root, 'index.html'), '<!doctype html><div id="root"></div>');
writeFileSync(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)');
writeFileSync(path.join(root, '.env'), 'SECRET=1');
const app = buildApp({
  config: loadConfig({ NODE_ENV: 'test' }),
  readiness: okReadiness,
  logStream: new LogCapture(),
  webRoot: root,
});
afterAll(async () => {
  await app.close();
});

describe('resolveInside', () => {
  it.each(['/%00.js', '/.env', '/%E0%A4%A.js', '/assets/tool.exe'])('refuses %s', (p) => {
    expect(resolveInside(root, p)).toBeNull();
  });
  it.each(['/../etc/passwd.txt', '/..%2f..%2fetc%2fpasswd.txt', '/assets/../../x.js'])(
    'clamps %s inside the root',
    (p) => {
      const resolved = resolveInside(root, p);
      expect(resolved === null || resolved.startsWith(root + path.sep)).toBe(true);
    },
  );
  it('allows files inside the root with a known type', () => {
    expect(resolveInside(root, '/assets/app-abc123.js')).toBe(path.join(root, 'assets', 'app-abc123.js'));
    expect(resolveInside(root, '/assets/tool.exe')).toBeNull();
  });
});

describe('web serving', () => {
  it('serves fingerprinted assets with a long cache and the right type, with security headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.headers['cache-control']).toContain('immutable');
    expect(res.headers['content-security-policy']).toContain("script-src 'self'");
  });

  it('falls back to index.html for client routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/b/123/members?x=1' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('id="root"');
  });

  it('never serves the app shell for /api paths or missing files', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/..%2f..%2fetc%2fpasswd' })).statusCode).toBe(404);
    const dotfile = await app.inject({ method: 'GET', url: '/.env' });
    expect(dotfile.statusCode).toBe(404);
    expect(dotfile.body).not.toContain('SECRET');
    expect((await app.inject({ method: 'GET', url: '/assets/..%2f.env' })).statusCode).toBe(404);
  });
});
