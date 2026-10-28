// Envelope encryption for integration secrets (FR-HUB-3 AC2, ADR-13, T12).
// Each secret gets its own random 256-bit data key; the value is sealed with
// AES-256-GCM under that key, and the data key is sealed with the current
// key-encryption key (KEK). KEKs come from the environment, never the
// database. Both seals bind the business, secret ID and purpose as
// additional data, so a ciphertext copied to another row or tenant fails.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface Keyring {
  /** Version name of the KEK used for new secrets and rewrapping. */
  readonly current: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export class KeyringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringError';
  }
}

/**
 * Parses `SECRETS_KEK`: comma-separated `version:base64` entries, the first
 * being current, each key exactly 32 bytes. Messages never include key material.
 */
export function parseKeyring(text: string): Keyring {
  const keys = new Map<string, Buffer>();
  let current: string | undefined;
  for (const entry of text
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const m = /^([a-z0-9_-]{1,20}):([A-Za-z0-9+/=]+)$/.exec(entry);
    if (!m?.[1] || !m[2]) throw new KeyringError('SECRETS_KEK: each entry must be version:base64key');
    const key = Buffer.from(m[2], 'base64');
    if (key.length !== 32) throw new KeyringError(`SECRETS_KEK: key ${m[1]} must be 32 bytes`);
    if (keys.has(m[1])) throw new KeyringError(`SECRETS_KEK: version ${m[1]} appears twice`);
    keys.set(m[1], key);
    current ??= m[1];
  }
  if (!current) throw new KeyringError('SECRETS_KEK: no key given');
  return { current, keys };
}

export interface SealedSecret {
  readonly kekVersion: string;
  /** iv (12) | tag (16) | encrypted data key (32). */
  readonly wrappedKey: Buffer;
  /** iv (12) | tag (16) | encrypted value. */
  readonly payload: Buffer;
}

const seal = (key: Buffer, plain: Buffer, aad: string): Buffer => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
};

const open = (key: Buffer, sealed: Buffer, aad: string): Buffer => {
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
};

const kekOf = (keyring: Keyring, version: string): Buffer => {
  const k = keyring.keys.get(version);
  if (!k) throw new KeyringError(`no key-encryption key with version ${version}`);
  return k;
};

/** Additional data binding a secret to its row. */
export const secretAad = (businessId: string, secretId: string, purpose: string) =>
  `lbgos-secret:v1:${businessId}:${secretId}:${purpose}`;

export function sealSecret(keyring: Keyring, value: string, aad: string): SealedSecret {
  const dataKey = randomBytes(32);
  try {
    return {
      kekVersion: keyring.current,
      wrappedKey: seal(kekOf(keyring, keyring.current), dataKey, `${aad}:kek:${keyring.current}`),
      payload: seal(dataKey, Buffer.from(value, 'utf8'), aad),
    };
  } finally {
    dataKey.fill(0);
  }
}

export function openSecret(keyring: Keyring, sealed: SealedSecret, aad: string): string {
  const dataKey = open(kekOf(keyring, sealed.kekVersion), sealed.wrappedKey, `${aad}:kek:${sealed.kekVersion}`);
  try {
    return open(dataKey, sealed.payload, aad).toString('utf8');
  } finally {
    dataKey.fill(0);
  }
}

/** Re-seals the data key under the current KEK (KEK rotation); the payload is unchanged. */
export function rewrapSecret(keyring: Keyring, sealed: SealedSecret, aad: string): SealedSecret {
  if (sealed.kekVersion === keyring.current) return sealed;
  const dataKey = open(kekOf(keyring, sealed.kekVersion), sealed.wrappedKey, `${aad}:kek:${sealed.kekVersion}`);
  try {
    return {
      kekVersion: keyring.current,
      wrappedKey: seal(kekOf(keyring, keyring.current), dataKey, `${aad}:kek:${keyring.current}`),
      payload: sealed.payload,
    };
  } finally {
    dataKey.fill(0);
  }
}

/** The hint shown for a stored secret: the last 4 characters, only when the value is long enough not to give much away. */
export const secretHint = (value: string): string | null => (value.length >= 12 ? value.slice(-4) : null);
