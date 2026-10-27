-- Migration 0003 — authentication tables (D-019).
-- The Better Auth section is the reviewed output of
-- packages/modules/scripts/generate-auth-schema.ts for better-auth 1.7.14 with
-- the two-factor plugin and database rate limiting. Regenerate and diff when
-- upgrading Better Auth or changing its plugins.
-- Tables are created by lbgos_owner in schema auth; default privileges from
-- 0002 give lbgos_auth (and only lbgos_auth) DML access.

set local search_path = auth, public;

-- ---- Better Auth (generated) ----------------------------------------------
create table "user" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "twoFactorEnabled" boolean);
create table "session" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" uuid not null references "user" ("id") on delete cascade);
create table "account" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "accountId" text not null, "providerId" text not null, "userId" uuid not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);
create table "verification" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);
create table "twoFactor" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "secret" text not null, "backupCodes" text not null, "userId" uuid not null references "user" ("id") on delete cascade, "verified" boolean, "failedVerificationCount" integer, "lockedUntil" timestamptz);
create table "rateLimit" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);
create index "session_userId_idx" on "session" ("userId");
create index "account_userId_idx" on "account" ("userId");
create index "verification_identifier_idx" on "verification" ("identifier");
create index "twoFactor_secret_idx" on "twoFactor" ("secret");
create index "twoFactor_userId_idx" on "twoFactor" ("userId");

-- ---- Our additions ----------------------------------------------------------

-- Per-account sign-in failures for lockout (FR-AUTH-4 AC1). account_key is a
-- SHA-256 of the normalised email, recorded whether or not the account exists.
create table sign_in_failures (
  id           bigint generated always as identity primary key,
  account_key  text not null check (account_key ~ '^[0-9a-f]{64}$'),
  failed_at    timestamptz not null default now()
);
create index sign_in_failures_key_time_idx on sign_in_failures (account_key, failed_at);

-- Last activity per session, for idle timeouts (FR-AUTH-1 AC3); Better Auth
-- sessions have absolute expiry only.
create table session_activity (
  session_id    uuid primary key references "session" ("id") on delete cascade,
  last_seen_at  timestamptz not null default now()
);
