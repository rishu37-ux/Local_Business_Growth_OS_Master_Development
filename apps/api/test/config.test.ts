import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';

describe('loadConfig (3.4 AC1)', () => {
  it('applies safe defaults for local development', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ NODE_ENV: 'development', HOST: '127.0.0.1', PORT: 3000, TRUST_PROXY_HOPS: 0 });
  });

  it('rejects invalid values and names the variable', () => {
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ DATABASE_URL_APP: 'mysql://x' })).toThrow(/DATABASE_URL_APP/);
  });

  it('requires database URLs and a session secret in production', () => {
    try {
      loadConfig({ NODE_ENV: 'production' });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const problems = (err as ConfigError).problems.join(' ');
      for (const key of ['DATABASE_URL_APP', 'DATABASE_URL_PLATFORM', 'DATABASE_URL_AUTH', 'SESSION_SECRET']) {
        expect(problems).toContain(key);
      }
    }
  });

  it('never echoes secret values in errors', () => {
    const secret = 'short-but-very-secret';
    expect(() => loadConfig({ SESSION_SECRET: secret })).toThrow(ConfigError);
    try {
      loadConfig({ SESSION_SECRET: secret, DATABASE_URL_APP: 'postgres-ish://user:hunter2@db' });
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(secret);
      expect(message).not.toContain('hunter2');
    }
  });
});
