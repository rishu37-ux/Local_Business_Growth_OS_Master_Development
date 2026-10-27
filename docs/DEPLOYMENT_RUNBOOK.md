# Deployment Runbook

Status: **Plan only — nothing has been deployed, and no procedure here has been rehearsed.** The hosting target is the ADR-18 recommendation (DigitalOcean BLR1 + Cloudflare), pending user confirmation (Q2). Provider-specific steps must be checked against current provider documentation when the environment is created.

Last updated: 2026-10-27 (Phase 2)

## 1. Environments

| Environment | Purpose | Data | Status |
|---|---|---|---|
| local | Development | Synthetic only | Throwaway PostgreSQL harness exists (`scripts/with-throwaway-pg.sh`); app not yet built |
| ci | Automated tests | Synthetic, ephemeral | **Running** — GitHub Actions `ci.yml`, first run green (TR-0006) |
| staging | Pre-release verification, restore drills | Synthetic / anonymised only | Not set up |
| production | Pilot and customers | Real | Not set up |

Staging and production are separate projects/accounts with separate credentials, databases, buckets and KEKs. Production data is never copied to staging.

## 2. Local development (current facts)

- Node.js 22.22 and pnpm 10 in the cloud dev session (production target: Node 24 LTS, ADR-01).
- PostgreSQL 16 server binaries at `/usr/lib/postgresql/16/bin`; `scripts/with-throwaway-pg.sh <cmd>` starts a throwaway cluster (as the `postgres` OS user when run as root), creates the `lbgos_*` roles, applies the schema draft, runs the command and deletes the cluster.
- Checks: `scripts/check-docs.sh`, `scripts/test-schema-draft.sh`, `cd spikes/tenant-context && npm ci && npm test`.
- The Docker daemon is not available in the cloud session; Docker Compose for developer machines comes in Phase 3.

## 3. Deployment design

**Artifacts:** one container image built from the monorepo with entrypoints `api`, `worker`, `worker-heavy` (Chromium for PDF, OCR pre-processing), and `migrate`; the SPA is built as static assets served by the API under `/` (same origin). Images are tagged with the git SHA; dependencies come from the frozen lockfile.

**Pipeline (planned):**
1. A PR runs CI (ADR-17). Merging to `main` builds the image once and pushes it to the registry.
2. Deploy to **staging**: run the `migrate` job (owner role), then roll out `api`/`worker`, then smoke tests (health, sign-in with a synthetic account, create/issue a synthetic invoice, cross-tenant probe).
3. Deploy the same image to **production** after manual approval: `migrate` → rolling update of `api` (≥2 instances once HA is enabled) → workers → smoke tests (read-only checks only in production).
4. Record version, migration ID, operator and time in `CHANGELOG.md` and the platform audit log.

**Migrations (expand/contract):** every migration must be backward-compatible with the previous app version. Step 1 adds columns/tables/policies; step 2 deploys code using them; step 3, in a later release, removes old structures. Destructive changes are never combined with the release that stops using them. Policies and grants are part of migrations and covered by the DB test suite.

**Secrets:** injected as encrypted environment variables of the platform (DB URLs per role, session secret, KEK, provider keys). Never baked into images, never logged. Rotation is documented per secret in Phase 3.

## 4. Backup and recovery (design; restore test in Phase 9)

| Asset | Mechanism | Target |
|---|---|---|
| PostgreSQL | Provider-managed daily backups + point-in-time recovery (window to verify with provider) | RPO ≤ 15 min (PITR), RTO ≤ 4 h for the pilot |
| PostgreSQL, extra copy | Nightly logical dump (`pg_dump -Fc`) encrypted with a separate key, stored in a different provider/account | Survives provider-account loss; 30-day retention |
| Object storage | Bucket versioning (if supported) + nightly sync to the secondary location | RPO 24 h |
| Configuration | Infrastructure and app config as code in the repo (no secrets) | Rebuild from repo |
| Secrets / KEK | Stored in the platform secret store **and** an offline, access-controlled escrow (two-person access) | Losing the KEK makes tenant integration secrets unrecoverable (tenants re-enter them) |

**Restore drill (Phase 9 exit criterion, then quarterly):** restore the latest backup and a point-in-time target into staging; run the migration status check, the DB test suite and reconciliation reports (stock = Σ movements, ledger balances, invoice numbering continuity); record actual RPO/RTO in `TEST_REPORT.md`.

## 5. Rollback

- **Application:** redeploy the previous image tag. This is always possible because migrations are expand/contract.
- **Migration failure:** migrations run in transactions; a failed migration rolls back and the deploy stops. A migration that succeeded but is wrong is fixed by a new forward migration, never by editing history.
- **Data errors:** corrected only through reversal/correction records (stock, ledger, invoices); never by ad-hoc UPDATE/DELETE. Superuser data fixes need two-person approval and an audit note.
- **Feature flags** gate risky features (e.g. auto-send reminders) so they can be switched off without a deploy.

## 6. Incident response (outline; complete before pilot)

1. Detect: alerts (error rate, failed jobs, health checks, auth anomalies), user reports.
2. Triage severity (S1 data exposure/integrity, S2 outage, S3 degraded).
3. Contain: disable the affected feature or integration, revoke/rotate credentials, block at the edge.
4. Communicate: affected tenants; legal/regulatory notification duties to be confirmed with counsel (e.g. CERT-In reporting timelines and DPDP Act obligations — **not verified here**).
5. Recover, then post-incident review with actions in `NEXT_STEPS.md`.
