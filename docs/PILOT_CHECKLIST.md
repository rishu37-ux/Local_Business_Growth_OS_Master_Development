# Pilot readiness checklist (Phase 9.5)

Version 1.0 — 2026-10-28. The conditions that must hold before one real shop uses the system with real data. **The pilot has not started.** Every item marked Blocked waits on an input from the user (open questions Q1–Q6 in `NEXT_STEPS.md`). Status values: **Ready** (done and shown by an executed check), **Prepared** (procedure or code exists, not yet done for real), **Blocked** (needs an input), **Open** (work to do).

| # | Area | Condition | Owner | Status | Evidence / what is missing |
|---|---|---|---|---|---|
| 1 | Shop | A pilot shop is chosen. Its owner agrees to the pilot terms (data use, support hours, what happens to data afterwards). | User | **Blocked (Q1)** | — |
| 2 | Hosting | Production and staging environments exist in India, with a managed PostgreSQL 16, object storage, and a secret store for `SESSION_SECRET`, `SECRETS_KEK` and DB passwords. | User (decision), developer (setup) | **Blocked (Q2)** | `DEPLOYMENT_RUNBOOK.md` §1, §3 |
| 3 | Backups | Automated encrypted backups and PITR are on at the provider. A restore **on that provider** is done and timed (RPO/RTO recorded). | Developer, after #2 | **Prepared** | Drill passes in a throwaway cluster (TR-0044 #5–7); the provider restore is not done |
| 4 | Domain/TLS | A domain with TLS on the edge. HSTS is already sent by the app. | User | **Blocked (Q6)** | — |
| 5 | Email | A transactional email provider for verification and reset. Production start is refused without one. | User (account), developer | **Blocked (Q6, Q4)** | TR-0007 #22 |
| 6 | Auth | Self-hosted auth (D-019/D-024) confirmed, or a managed provider named. | User | **Blocked (Q3)** | Self-hosted auth implemented and tested (TR-0007) |
| 7 | Security | Internal ASVS L2-aligned review done; no high finding open. | Developer | **Ready** | `SECURITY_REVIEW.md` |
| 8 | Security | Branch protection on `main` with the CI checks required. | Repository owner | **Open** | SR-08 |
| 9 | Security | External penetration test, at least of auth, tenant isolation and uploads. | User | **Open** (recommended before the pilot; required before broad launch) | SR-10 |
| 10 | Tenant isolation | The route-table sweep and the RLS check pass. | Developer | **Ready** | TR-0044 #1–4 |
| 11 | Tax | GST rates, the invoice format and the rounding rules are reviewed by a tax professional for the shop's state and products. | User | **Blocked (Q5)** | `SRS.md` tax notes; tax engine tests TR-0017 |
| 12 | Legal | The privacy notice, terms and consent wording, and retention and erasure are reviewed for the DPDP Act. TRAI DLT applies only if SMS is used. | User (counsel) | **Open** | NFR-12; nothing is claimed as compliant |
| 13 | Integrations | Only the integrations the shop needs are connected with real accounts and tested once in staging. Everything else stays off. | User (accounts), developer | **Blocked (Q4)** | `INTEGRATIONS_STATUS.md` — all mock today |
| 14 | Devices | Print on the shop's real printer (A4 and/or 80 mm thermal); scan on the shop's phone; browser check on the shop's devices. | Developer with the shop | **Open** | FR-PRN-1 AC4; Firefox/WebKit not tested (TR-0044 #10) |
| 15 | Data entry | A plan for opening stock, customers and suppliers: who enters them, when, and how they are checked (stock count = system count). | User with the shop | **Open** | No bulk import exists yet; entry is screen by screen (a CSV import would be new work) |
| 16 | Plan limits | Plan allowances (AI units, messages, storage) are set as a product decision. | User | **Open** | TR-0041 (mechanism tested; values open) |
| 17 | Support | A support contact, hours and response targets. Incident response steps are written; the support access procedure is time-boxed and audited. | User, developer | **Open** | `DEPLOYMENT_RUNBOOK.md` §6 (outline) |
| 18 | Rollback | A previous-image redeploy is practised in staging. Data corrections only by reversal records. | Developer, after #2 | **Prepared** | `DEPLOYMENT_RUNBOOK.md` §5 |
| 19 | Monitoring | Error rate, failed jobs, health checks and auth anomalies alert someone. | Developer, after #2 | **Prepared** | Job records and monitoring screen (TR-0041, TR-0043); no alert channel yet |
| 20 | Exit | Pilot success measures agreed (e.g. invoices issued without errors, stock count matches, time to bill). An end-of-pilot review is planned. | User | **Open** | — |

**Go/no-go rule:** the pilot starts only when items 1–6 and 11–13 are no longer Blocked and items 3, 8, 14, 15, 17 and 19 are done. Starting earlier means real customer data without a tested restore, a reviewed tax setup or a support path.
