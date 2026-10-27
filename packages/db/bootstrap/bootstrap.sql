-- One-time, per-environment database bootstrap. Run by a superuser / provider
-- admin before the first migration. Not a migration: roles are cluster-level
-- objects, and migrations run as lbgos_owner, which cannot create roles.
--
-- Production: create each LOGIN role with a strong generated password stored in
-- the platform secret store (never in this file or the repository), e.g.
--   ALTER ROLE lbgos_app PASSWORD '<from secret store>';
-- The throwaway test harness relies on trust auth over a private Unix socket.

create role lbgos_owner login bypassrls;            -- owns objects; runs migrations only
create role lbgos_app login nobypassrls;            -- tenant requests (RLS)
create role lbgos_platform login nobypassrls;       -- platform-admin requests (D-015)
create role lbgos_auth login nobypassrls;           -- auth module only (D-019)

create extension if not exists pgcrypto;
create extension if not exists citext;

do $$ begin execute format('grant create on database %I to lbgos_owner', current_database()); end $$;
