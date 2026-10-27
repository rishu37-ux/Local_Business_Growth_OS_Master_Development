# Deployment Runbook

Status: **Plan only — nothing has been deployed, and no procedure here has been rehearsed.** The hosting target is the ADR-18 recommendation (DigitalOcean BLR1 + Cloudflare), pending user confirmation (Q2). Provider-specific steps must be checked against current provider documentation when the environment is created.

Last updated: 2026-10-27 (Phase 3)

## 1. Environments

| Environment | Purpose | Data | Status |
|---|---|---|---|
| local | Development | Synthetic only | Throwaway PostgreSQL harness; `scripts/dev-local.sh` runs the portal locally |
| ci | Automated tests | Synthetic, ephemeral | **Running** — GitHub Actions `ci.yml`, first run green (TR-0006) |
| staging | Pre-release verification, restore drills | Synthetic / anonymised only | Not set up |
| production | Pilot and customers | Real | Not set up |

Staging and production are separate projects/accounts with separate credentials, databases, buckets and KEKs. Production data is never copied to staging.

## 2. Local development (verified in the dev container)

```
pnpm install --frozen-lockfile
pnpm check                      # lint, format, typecheck, build, unit, DB and browser tests (throwaway PostgreSQL)
pnpm -F @lbgos/web build        # SPA → apps/web/dist (served by the API at /)
```

**Quickest local look at the portal:** `scripts/dev-local.sh`, then open http://127.0.0.1:3000. It starts a throwaway PostgreSQL (deleted on Ctrl+C), migrates, builds the web app and starts the API; dev emails are printed to the terminal, and it prints the `psql` command to grant a platform admin. Requires PostgreSQL 16+ server binaries locally.

Running the API locally against a persistent database:
1. Bootstrap once as a superuser: `psql -f packages/db/bootstrap/bootstrap.sql`. In real environments, set role passwords from the secret store.
2. Migrate: `LBGOS_MIGRATION_DATABASE_URL=postgres://lbgos_owner:...@host/db node packages/db/src/migrate-cli.ts`.
3. Start: `SESSION_SECRET=<32+ random chars> PUBLIC_BASE_URL=http://localhost:3000 node apps/api/src/server.ts`. `DATABASE_URL_*` are optional locally (libpq `PG*` variables are used with the role names). Verification/invitation emails are printed to stdout by the development mailers.
4. Grant a platform admin (operator action, owner role): `insert into lbg.platform_admins (user_id) select id from lbg.users where email = '<admin email>';` — the admin must then enrol MFA.
5. `NODE_ENV=production` start is refused until an email provider is configured (Q6).

Notes: the Docker daemon is unavailable in the cloud session. Server code runs on Node type stripping (D-023); TypeScript is typecheck-only.

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
