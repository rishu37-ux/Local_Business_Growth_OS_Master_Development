# Deployment Runbook

Status: **Placeholder — nothing has been deployed.** No hosting provider has been chosen (Phase 2 decision). Every procedure below is a requirement to be filled in and then actually rehearsed; none has been tested.

Last updated: 2026-10-27 (Phase 0)

## 1. Environments (planned)

| Environment | Purpose | Data | Status |
|---|---|---|---|
| local | Development | Synthetic only | Not set up |
| ci | Automated tests | Synthetic, ephemeral | Not set up |
| staging | Pre-release verification | Synthetic / anonymised | Not set up |
| production | Pilot and customers | Real | Not set up |

## 2. Local development (current known facts)

- Node.js 22 and pnpm available in the cloud dev session.
- PostgreSQL 16 server binaries at `/usr/lib/postgresql/16/bin`; must run as the `postgres` OS user (verified once in Phase 0).
- Docker daemon not available in the cloud session; developer machines may use Docker Compose (to be provided in Phase 3).

## 3. Deployment procedure — to be written in Phase 2/3

Must cover: build, migration (separate migration role, forward-only with tested rollback strategy), secrets injection from secret store, zero-downtime rollout, health checks, smoke tests.

## 4. Backup and recovery — to be written in Phase 2, tested in Phase 9

Must cover: encrypted automated backups, retention, point-in-time recovery, access restriction, **documented and executed restore test** with recorded RPO/RTO, object-storage backup/versioning.

## 5. Rollback — to be written in Phase 3

Must cover: application rollback, migration compatibility (expand/contract), feature flags, data correction via reversal records (never ad-hoc edits to ledgers).

## 6. Incident response — to be written before pilot (Phase 9)

Must cover: detection and alerting, severity levels, contacts, credential rotation steps, tenant notification, legal/regulatory notification requirements (to confirm with counsel), post-incident review.
