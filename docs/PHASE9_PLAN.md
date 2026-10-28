# Phase 9 plan — Security review, tenant-isolation tests, accessibility, responsive tests, backup restore test and pilot

Version 1.0 — 2026-10-28. Master prompt §11 (security requirements, OWASP ASVS-aligned checklist) and §Development process, Phase 9; SRS NFR-1 (accessibility), NFR-4 (tenant isolation), NFR-11 (backups), NFR-16 (browsers), NFR-17 (headers); threat model T1, T20, T21. Acceptance criteria (AC) are fixed **before** coding. Only executed checks count (`TEST_REPORT.md`).

**What this phase cannot do without the user:** a pilot with a real shop (Q1), a production hosting account where backups and point-in-time recovery are configured (Q2), a domain and TLS (Q6), an external penetration test, and legal/tax review. These are prepared, not claimed.

## Increment 9.1 — Tenant-isolation sweep (NFR-4, T1)
**Status: done (TR-0044 #1–4, D-065).** The sweep found one defect: an empty change to a category/brand gave 500 (fixed, SR-02).
- AC1: an automated test walks **every** registered `/api/businesses/:businessId/...` route (taken from the running app's route table, not a hand-kept list) and calls it as the owner of another business with this business's ID and real IDs of this business's records; no call may return 2xx or any of this business's data (expected 403/404).
- AC2: the same for a signed-out visitor (401) and for every route of the platform namespace called by a shop owner (403).
- AC3: every table in schema `lbg` that has a `business_id` column has row-level security enabled **and forced** and a policy; the test fails if a new table misses it.

## Increment 9.2 — Backup and restore drill (NFR-11, T20)
**Status: done in a throwaway cluster and in CI (TR-0044 #5–7, D-065); production backups need Q2.**
- AC1: a script takes a logical backup (`pg_dump`, custom format) of a database with synthetic data, restores it into a fresh database, and verifies: migration state equals the source, row counts of every table equal, RLS/forced RLS and policies present, grants of the application roles present, and a tenant-context query returns the same data.
- AC2: the drill runs in CI-like conditions (throwaway PostgreSQL) and its result is recorded; `DEPLOYMENT_RUNBOOK.md` gets the restore procedure and what remains for production (encrypted automated backups, PITR, off-site copy — need Q2).

## Increment 9.3 — Accessibility and responsive sweep (NFR-1, NFR-16)
**Status: done in Chromium (TR-0044 #10–11, D-065); Firefox/WebKit not run (not installed).**
- AC1: a browser test signs in as the owner of a shop with data and visits **every** screen in the business menu plus the main detail pages, at 360, 768 and 1280 px: 0 serious/critical axe violations (WCAG 2.2 AA tags), no horizontal page overflow, no CSP violations or page errors.
- AC2: keyboard-only: the main menu and one form per screen family can be reached with Tab and a visible focus indicator (focus outline style present).
- Firefox and WebKit: run if the browsers are available in the environment; otherwise recorded as not run.

## Increment 9.4 — Security review (ASVS-aligned)
**Status: done (`SECURITY_REVIEW.md`, TR-0044 #8–9, D-066).** Fixed: SR-01 webhook rate limit, SR-02. No high finding open; SR-03…SR-10 owned.
- AC1: `SECURITY_REVIEW.md` — an OWASP ASVS 4.0 level 2-aligned checklist for V1–V14 relevant to this system, each item with status (met / partly / not met / not applicable) and evidence (test IDs, code), plus the threat-model status updated.
- AC2: every finding rated high that can be fixed in code is fixed with a test; the rest are listed with an owner and reason.
- AC3: automated checks: dependency audit and secret scan (CI), security headers on every response type (API JSON, HTML, file downloads, errors), cookie flags, rate limits on sign-in and webhooks, request size limits.

## Increment 9.5 — Pilot readiness (blocked on Q1, Q2, Q6)
**Status: checklist written (`PILOT_CHECKLIST.md`); the pilot is blocked on Q1–Q6.**
- AC1: `PILOT_CHECKLIST.md`: what must be true before a real shop uses the system (hosting, backups verified there, domain/TLS, email provider, legal review, data entry plan, support contact, rollback), each with owner and status.
- The pilot itself is **not** run in this phase without the user's shop and hosting.

## Phase 9 exit
**Status: passed locally (TR-0044); CI result recorded when known. The pilot stays open (Q1–Q6).**
Isolation sweep, restore drill and accessibility sweep pass and are recorded; the ASVS review is written with every high finding fixed or explicitly owned; the pilot checklist lists what remains; CI is green. The pilot stays open until Q1/Q2/Q6 are answered.
