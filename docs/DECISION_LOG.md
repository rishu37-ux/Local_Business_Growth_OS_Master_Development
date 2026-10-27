# Decision Log

Format: ID · date · status (Proposed / Accepted / Superseded) · decision · rationale · alternatives considered.
"Proposed" decisions are working assumptions; they become "Accepted" in the Phase 2 architecture decision record.

---

### D-001 · 2026-10-27 · Accepted
**Decision:** Treat the project as greenfield and keep the master prompt file unchanged at the repository root.
**Rationale:** Phase 0 inspection found no code, manifests, migrations, tests or CI — only the prompt file.
**Alternatives:** None applicable.

### D-002 · 2026-10-27 · Accepted
**Decision:** Project memory lives in `/docs/*.md` committed to git, plus a root `CLAUDE.md` that instructs every new session to read it first.
**Rationale:** Required by prompt §13; the cloud session container is ephemeral, so only committed files survive.
**Alternatives:** AI-platform personal memory (rejected — not durable or reviewable).

### D-003 · 2026-10-27 · Proposed
**Decision:** Modular monolith in TypeScript: React + TypeScript + Tailwind frontend, TypeScript API backend, PostgreSQL database, background job queue.
**Rationale:** Recommended by the prompt; one deployable unit is simpler and cheaper for a pilot; module boundaries keep later extraction possible.
**Alternatives:** Microservices (rejected for now — premature); non-TS backend (rejected — one language across stack reduces cost).
**To decide in Phase 2:** specific frameworks (e.g., Fastify/NestJS/Hono; Vite SPA vs Next.js), ORM/query builder, queue technology (e.g., Postgres-backed queue vs Redis), monorepo tooling.

### D-004 · 2026-10-27 · Proposed
**Decision:** Enforce tenant isolation in two layers — service-layer scoping and PostgreSQL Row-Level Security keyed on `business_id` via a per-transaction setting.
**Rationale:** Prompt requires DB-level enforcement where supported; PostgreSQL 16 supports RLS and was verified runnable in this environment.
**Alternatives:** Schema-per-tenant / database-per-tenant (higher operational cost, harder migrations for many small shops; may revisit for large tenants).

### D-005 · 2026-10-27 · Proposed
**Decision:** Money stored as integer paise (or `NUMERIC`), never floating point; ledgers append-only with reversal entries.
**Rationale:** Financial accuracy and auditability requirements (prompt §2, §4, §5).
**Alternatives:** Float (rejected — rounding errors).

### D-006 · 2026-10-27 · Proposed
**Decision:** Defaults: INR, `Asia/Kolkata`, financial year April–March, all configurable per business.
**Rationale:** Pilot is an Indian mobile shop; prompt references GST and DLT.
**Alternatives:** None — values remain configurable.

### D-007 · 2026-10-27 · Accepted
**Decision:** Local development and tests use native PostgreSQL 16 binaries, not Docker, in this environment.
**Rationale:** Docker daemon is unavailable in the cloud session; PostgreSQL 16 server binaries are present and were verified to run.
**Alternatives:** Docker Compose (still the documented option for developer machines; CI may use service containers).
