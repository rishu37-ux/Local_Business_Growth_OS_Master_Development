// Password storage and policy (NFR-13, FR-AUTH-2 AC4).
import { hash, verify } from '@node-rs/argon2';

// @node-rs/argon2 declares `Algorithm` as an ambient const enum, which cannot be
// referenced under verbatimModuleSyntax / type stripping (D-023); 2 is
// Algorithm.Argon2id. A test asserts stored hashes start with $argon2id$.
const ARGON2ID_ALGORITHM = 2;

// OWASP Password Storage Cheat Sheet minimum for Argon2id: m=19 MiB, t=2, p=1.
const ARGON2ID = { algorithm: ARGON2ID_ALGORITHM, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2ID);
}

export async function verifyPassword(data: { hash: string; password: string }): Promise<boolean> {
  // Only Argon2id hashes are accepted; anything else (e.g. a library default
  // format) fails closed instead of being verified with a weaker algorithm.
  if (!data.hash.startsWith('$argon2id$')) return false;
  return verify(data.hash, data.password);
}

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

// Commonly used passwords that meet the length rule. Not a breached-password
// corpus: the online breached-password check (FR-AUTH-2 AC4) is a separate,
// configurable step because it needs network access.
const COMMON = new Set([
  '1234567890',
  '12345678910',
  '0123456789',
  '1111111111',
  '0000000000',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'qwertyuiop',
  'qwerty12345',
  'qwerty123456',
  '1q2w3e4r5t',
  'iloveyou123',
  'welcome123',
  'admin12345',
  'administrator',
  'letmein123',
  'abcdefghij',
  'abc1234567',
  'football123',
  'india12345',
  'india@123',
  'mobile12345',
]);

/** Returns a reason the password is unacceptable, or undefined if it passes. */
export function passwordProblem(password: string, context: { email?: string } = {}): string | undefined {
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'This password is too common.';
  if (/^(.)\1+$/.test(password)) return 'This password is too easy to guess.';
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'The password must not contain your email name.';
  return undefined;
}
