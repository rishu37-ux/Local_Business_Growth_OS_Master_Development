-- Migration 0002 — schema for authentication data (D-019, threat T32).
-- Credential, session and MFA tables (added with the auth module) live here and
-- are reachable only by lbgos_auth. lbgos_app and lbgos_platform get no access.

create schema auth authorization lbgos_owner;
revoke all on schema auth from public;
grant usage on schema auth to lbgos_auth;

alter default privileges for role lbgos_owner in schema auth
  grant select, insert, update, delete on tables to lbgos_auth;
alter default privileges for role lbgos_owner in schema auth
  grant usage, select on sequences to lbgos_auth;
