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

**Quickest local look at the portal:** `scripts/dev-local.sh`, then open http://127.0.0.1:3000. It starts a throwaway PostgreSQL (deleted on Ctrl+C), migrates, builds the web app and starts the API; dev emails are printed to the terminal, and it prints the `psql` command to grant a platform admin. Requires PostgreSQL 16+ server binaries locally. For real OCR of camera photos, install Tesseract first (`sudo apt install -y tesseract-ocr`); the script then sets `OCR_ENGINE=tesseract` (D-071), otherwise it uses the mock reader, which cannot read real photos.

**On a phone (testing only):**
1. In a second terminal, run `cloudflared tunnel --url http://127.0.0.1:3000`. It prints an `https://<name>.trycloudflare.com` address.
2. Start the portal with that address: `PORTAL_URL=https://<name>.trycloudflare.com scripts/dev-local.sh`.
3. Open the address on the phone.

How it works:
- The CSRF check accepts only that origin.
- Cookies are `Secure`.
- One proxy hop is trusted for client addresses.
- The live camera works because the page is https.

While both run, the portal is reachable from the internet, so use test data only and stop both afterwards. The script refuses any `PORTAL_URL` other than `http://127.0.0.1:3000` or an https address.

Running the API locally against a persistent database:
1. Bootstrap once as a superuser: `psql -f packages/db/bootstrap/bootstrap.sql`. In real environments, set role passwords from the secret store. Environments bootstrapped before migration 0022 must first run `create role lbgos_secrets login nobypassrls;` (D-055).
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

**Secrets:** injected as encrypted environment variables of the platform (DB URLs per role incl. `DATABASE_URL_SECRETS`, session secret, `SECRETS_KEK`, provider keys). KEK rotation: prepend the new `version:key` to `SECRETS_KEK`, deploy, run the rewrap for each business (`rewrapSecrets`, secrets role), then remove the old key. Never baked into images, never logged. Rotation is documented per secret in Phase 3.

## 4. Backup and recovery (design; restore drilled in a throwaway cluster in Phase 9)

| Asset | Mechanism | Target |
|---|---|---|
| PostgreSQL | Provider-managed daily backups + point-in-time recovery (window to verify with provider) | RPO ≤ 15 min (PITR), RTO ≤ 4 h for the pilot |
| PostgreSQL, extra copy | Nightly logical dump (`pg_dump -Fc`) encrypted with a separate key, stored in a different provider/account | Survives provider-account loss; 30-day retention |
| Object storage | Bucket versioning (if supported) + nightly sync to the secondary location | RPO 24 h |
| Configuration | Infrastructure and app config as code in the repo (no secrets) | Rebuild from repo |
| Secrets / KEK | Stored in the platform secret store **and** an offline, access-controlled escrow (two-person access) | Losing the KEK makes tenant integration secrets unrecoverable (tenants re-enter them) |

**Restore procedure (logical backup) — drilled in Phase 9 (TR-0044 #5–7, `scripts/backup-restore-drill.sh`, `pnpm drill`, also run in CI):**

1. Stop writes: put the app in maintenance (scale the API to zero, or point the edge at a static page). The job runner stops with the API.
2. Take or choose the backup: `pg_dump -Fc -d <db> -f lbgos-<date>.dump`. Run it as the owner role, never as `lbgos_app`, because RLS would hide rows from a tenant role.
3. Create an empty target database. The roles (`lbgos_app`, `lbgos_platform`, `lbgos_auth`, `lbgos_secrets`) are cluster-wide and must already exist. Create them with the migration setup if the cluster is new.
4. Restore: `pg_restore -d <new db> --exit-on-error lbgos-<date>.dump`.
5. Verify before switching. These are the drill's checks:
   - applied migrations equal the source;
   - the row count of every `lbg`/`auth` table is plausible against the backup;
   - RLS is enabled and forced on every tenant table, with its policies;
   - the grants and column grants of the application roles are present;
   - the definer functions are present;
   - `lbgos_app` sees 0 rows without a tenant context and a business's own rows with it.
   Then run the reconciliation reports (stock = Σ movements, ledger balances, invoice numbering continuity).
6. Point the API at the restored database, start it, check `/readyz`, and sign in as a test user.
7. Record the actual RPO (age of the backup) and RTO (stop → ready) in `TEST_REPORT.md`.

**Not yet done for production (needs Q2 hosting):**
- encrypted automated backups at the provider;
- point-in-time recovery and a PITR restore test;
- the off-site encrypted copy;
- object-storage backup;
- KEK escrow;
- a timed RPO/RTO measurement on real hardware.

The drill above uses synthetic data in a throwaway cluster.

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
