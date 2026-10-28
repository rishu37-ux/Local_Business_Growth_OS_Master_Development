// Increment 7.2: envelope encryption (FR-HUB-3 AC2, ADR-13). Synthetic keys only.
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { openSecret, parseKeyring, rewrapSecret, sealSecret, secretAad, secretHint } from '@lbgos/modules/secrets';

const k1 = Buffer.alloc(32, 1).toString('base64');
const k2 = Buffer.alloc(32, 2).toString('base64');
const B = '11111111-1111-4111-8111-111111111111';
const S = '22222222-2222-4222-8222-222222222222';
const VALUE = 'sk-test-SYNTHETIC-abcdefghijklmnop';

describe('keyring (ADR-13)', () => {
  it('parses versions, the first is current; refuses bad keys without echoing them', () => {
    const ring = parseKeyring(`v2:${k2}, v1:${k1}`);
    expect(ring.current).toBe('v2');
    expect([...ring.keys.keys()]).toEqual(['v2', 'v1']);
    for (const bad of ['', 'v1', `v1:${Buffer.alloc(16).toString('base64')}`, `v1:${k1},v1:${k2}`, `V1:${k1}`]) {
      let message = '';
      try {
        parseKeyring(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/^SECRETS_KEK/);
      expect(message).not.toContain(k1);
      expect(message).not.toContain(k2);
    }
  });

  it('a malformed SECRETS_KEK stops the server without echoing the value', () => {
    let message = '';
    try {
      loadConfig({ NODE_ENV: 'test', SECRETS_KEK: 'v1:not-base64!!' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('SECRETS_KEK');
    expect(message).not.toContain('not-base64');
  });
});

describe('sealing (FR-HUB-3 AC2)', () => {
  const ring = parseKeyring(`v1:${k1}`);
  const aad = secretAad(B, S, 'api_key');

  it('round-trips; each seal uses a fresh key and nonce; the plaintext is not in the ciphertext', () => {
    const a = sealSecret(ring, VALUE, aad);
    const b = sealSecret(ring, VALUE, aad);
    expect(openSecret(ring, a, aad)).toBe(VALUE);
    expect(a.payload.equals(b.payload)).toBe(false);
    expect(a.wrappedKey.equals(b.wrappedKey)).toBe(false);
    expect(a.wrappedKey.length).toBe(60);
    expect(Buffer.concat([a.payload, a.wrappedKey]).includes(Buffer.from('SYNTHETIC'))).toBe(false);
  });

  it('tampering or moving the ciphertext to another row or business fails', () => {
    const sealed = sealSecret(ring, VALUE, aad);
    const flipped = Buffer.from(sealed.payload);
    flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
    expect(() => openSecret(ring, { ...sealed, payload: flipped }, aad)).toThrow();
    expect(() => openSecret(ring, sealed, secretAad(B, '33333333-3333-4333-8333-333333333333', 'api_key'))).toThrow();
    expect(() => openSecret(ring, sealed, secretAad('44444444-4444-4444-8444-444444444444', S, 'api_key'))).toThrow();
    expect(() => openSecret(ring, sealed, secretAad(B, S, 'webhook_secret'))).toThrow();
    expect(() => openSecret(parseKeyring(`v1:${k2}`), sealed, aad)).toThrow(); // wrong KEK
  });

  it('KEK rotation re-seals the data key only; afterwards the old KEK is not needed', () => {
    const sealed = sealSecret(ring, VALUE, aad);
    const both = parseKeyring(`v2:${k2},v1:${k1}`);
    const next = rewrapSecret(both, sealed, aad);
    expect(next.kekVersion).toBe('v2');
    expect(next.payload.equals(sealed.payload)).toBe(true);
    expect(openSecret(parseKeyring(`v2:${k2}`), next, aad)).toBe(VALUE);
    expect(rewrapSecret(both, next, aad)).toBe(next); // already current
  });

  it('the hint is the last 4 characters of a long value only', () => {
    expect(secretHint(VALUE)).toBe('mnop');
    expect(secretHint('short-secret')).toBe('cret');
    expect(secretHint('tiny-secret')).toBeNull();
  });
});
