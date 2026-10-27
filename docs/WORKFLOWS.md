# Workflows and State Machines

Version 1.0 (Phase 1) — 2026-10-27. Status: **Specified, not implemented.**
Any transition not listed for a state machine is invalid and must be rejected (409) by the server. Every transition is audited.

## 1. Business status

| From | To | Actor | Conditions |
|---|---|---|---|
| (none) | PENDING_APPROVAL | Applicant | Self-registration with verified email |
| (none) | APPROVED_SETUP_PENDING | Platform Admin | Admin-created business |
| PENDING_APPROVAL | APPROVED_SETUP_PENDING | Platform Admin | Approve |
| PENDING_APPROVAL | CHANGES_REQUESTED | Platform Admin | Reason required |
| PENDING_APPROVAL | REJECTED | Platform Admin | Reason required |
| CHANGES_REQUESTED | PENDING_APPROVAL | Applicant | Resubmit |
| CHANGES_REQUESTED | REJECTED | Platform Admin | Reason required (e.g. no response) |
| APPROVED_SETUP_PENDING | ACTIVE | System | Required wizard steps complete incl. owner MFA (FR-ONB-2) |
| ACTIVE | SUSPENDED | Platform Admin | Reason required |
| APPROVED_SETUP_PENDING | SUSPENDED | Platform Admin | Reason required |
| SUSPENDED | ACTIVE | Platform Admin | Reinstate, reason required (returns to APPROVED_SETUP_PENDING if setup incomplete) |

`REJECTED` is terminal; a new application can be submitted.

**Access by status:** PENDING_APPROVAL / CHANGES_REQUESTED → application only. APPROVED_SETUP_PENDING → owner: setup wizard + catalogue/settings; no sales, messaging or campaigns. ACTIVE → full. SUSPENDED → owner read-only + export (D-009). REJECTED → none.

## 2. Registration → approval → setup (flow)

1. Applicant registers → verifies email → submits application (PENDING_APPROVAL).
2. Platform Admin reviews: approve / request changes (reason) / reject (reason). Applicant notified.
3. On approval: owner completes wizard: details → tax profile & invoice series → **MFA enrolment** → staff → products (manual or CSV) → integrations (optional) → preferences.
4. System checks required steps → ACTIVE. Default roles created at approval time.

## 3. Subscription status (independent of business status — D-010)

`TRIALING → ACTIVE` (payment confirmed) · `TRIALING → EXPIRED` (trial ends without payment) · `ACTIVE → PAST_DUE` (renewal payment failed) · `PAST_DUE → ACTIVE` (paid) · `PAST_DUE → EXPIRED` (grace over, configurable) · `ACTIVE → CANCELLED` (owner cancels; access until period end) · `CANCELLED → EXPIRED` (period end) · `EXPIRED → ACTIVE` (paid).
Read-only when `EXPIRED` or `PAST_DUE` beyond grace.

## 4. Serialized unit status

| From | To | Trigger |
|---|---|---|
| (none) | IN_STOCK | Purchase posted (or opening stock import) |
| IN_STOCK | RESERVED | Cart hold with "reserve on hold" enabled |
| RESERVED | IN_STOCK | Hold released/expired |
| IN_STOCK / RESERVED | SOLD | Invoice issued |
| SOLD | PENDING_INSPECTION | Sale return / credit note with goods returned |
| SOLD | IN_STOCK | Invoice cancelled within window **and** user confirms the unit never left the shop (reversal movement) |
| SOLD | PENDING_INSPECTION | Invoice cancelled within window and the unit had been handed over |
| PENDING_INSPECTION | IN_STOCK | Inspection outcome RESTOCK |
| PENDING_INSPECTION | DAMAGED | Inspection outcome DAMAGED |
| PENDING_INSPECTION | IN_REPAIR | Inspection outcome REPAIR |
| IN_REPAIR | PENDING_INSPECTION | Repair completed |
| PENDING_INSPECTION / DAMAGED / IN_STOCK | RETURNED_TO_SUPPLIER | Purchase return posted |
| IN_STOCK / DAMAGED | WRITTEN_OFF | Approved adjustment |
| any | (reversal) | Approved correction: previous status restored via REVERSAL movement |

Only `IN_STOCK` units can be sold. Each transition corresponds to a stock movement row.

## 5. Purchase → stock-in

1. Create draft purchase (manually or from OCR — §7): supplier, supplier invoice no./date, lines.
2. For serialized lines, enter/scan IMEIs (count = quantity); IMEI validation runs on entry (Luhn, duplicates).
3. Review totals: code recomputes line and tax totals; differences from supplier's printed totals shown.
4. Post (`purchases.post`): in one transaction — purchase status DRAFT → POSTED; units created IN_STOCK; PURCHASE movements; weighted average cost updated (non-serialized); supplier payable entry; audit event.
5. Mistakes: reverse the posted purchase (POSTED → REVERSED, reversal movements; only allowed if none of its units were sold — otherwise use purchase return/correction) and re-enter.

Purchase status: `DRAFT → POSTED → REVERSED`; `DRAFT → DISCARDED`.

## 6. POS sale → invoice → payment → ledger

1. Cart: add items (search/scan); serialized items require a specific IN_STOCK unit.
2. Discounts validated against user limit; over-limit → approver re-authentication or approval request.
3. Customer: mobile lookup/create (optional for fully paid walk-in).
4. Tax computed by tax engine (D-013); place of supply set.
5. Payments: one or more methods; partial allowed with customer.
6. Issue (one transaction): allocate invoice number (gapless, row lock); invoice DRAFT → ISSUED; SALE movements (units → SOLD); ledger: INVOICE debit, PAYMENT credits; allocations; COGS snapshot; audit.
7. Print/PDF; optional WhatsApp/SMS/email of invoice (transactional, consent rules apply).

Invoice document status: `DRAFT → ISSUED → CANCELLED` (within window, D-016) · `DRAFT → DISCARDED`. Payment status (derived from allocations): `UNPAID`, `PARTIALLY_PAID`, `PAID`; credit notes reduce amount due.

## 7. OCR scan → review → post

OCR job status: `UPLOADED → QUEUED → PROCESSING → NEEDS_REVIEW → COMPLETED` (user created records) · `NEEDS_REVIEW → DISCARDED` · `PROCESSING → FAILED` (file invalid, provider error, timeout) · `FAILED → QUEUED` (user retry, max 3).

1. Upload/capture → file checks (type, size, malware if configured) → stored privately → job queued.
2. Worker: OCR → (optional) model structures fields as schema-validated JSON → deterministic validators (IMEI, numbers, totals, duplicates) → catalogue matching proposals.
3. Review screen: fields with confidence & evidence; user edits/confirms; missing stays empty.
4. Product label → create/update units or catalogue entries after confirmation. Supplier invoice → **draft purchase** (§5), which still needs posting.

## 8. Customer return → inspection → restock/refund

1. Locate original invoice (number, IMEI, or customer). Select lines/units and quantities.
2. Choose settlement: refund (requires `refunds.approve`), credit to customer advance, or exchange (new sale).
3. Issue credit note (own series) → SALE_RETURN movements → units PENDING_INSPECTION → ledger CREDIT_NOTE credit (+ REFUND debit if money paid out).
4. Inspection (`returns.inspect`): RESTOCK / DAMAGED / REPAIR / RETURN_TO_SUPPLIER.

## 9. Messages and social posts

Message status: `DRAFT → PENDING_APPROVAL → APPROVED → QUEUED → SUBMITTED → SENT → DELIVERED → READ`; `SUBMITTED/SENT → FAILED`; `QUEUED → BLOCKED` (suppressed/no consent/quota) ; `APPROVED/QUEUED → CANCELLED`. `SENT`, `DELIVERED`, `READ` only from provider confirmation. Transactional messages may skip DRAFT/approval.
Social post: `DRAFT → PENDING_APPROVAL → APPROVED → SCHEDULED → SUBMITTED → PUBLISHED | FAILED`; `PUBLISHED` only when the provider returns a post ID.
Campaign: `DRAFT → PENDING_APPROVAL → APPROVED → SCHEDULED → RUNNING → COMPLETED | PARTIALLY_FAILED | CANCELLED`; editing an approved campaign returns it to DRAFT.

## 10. Integration status

`PLANNED → CONFIGURED` (record + secret saved) → `TESTED` (test connection succeeded) → `VERIFIED` (a real operation confirmed by provider response, e.g. message delivered) · any → `FAILED` (test/health failure) → `CONFIGURED` (after fix) · any → `DISABLED` · `DISABLED → CONFIGURED` · any → `REVOKED` (secret destroyed; terminal for that credential).

## 11. Approval requests

`PENDING → APPROVED → EXECUTED | EXECUTION_FAILED` · `PENDING → REJECTED` · `PENDING → EXPIRED` (default 72 h) · `PENDING → CANCELLED` (by requester).
Request stores: business, requester (user or agent run), action type, exact payload (hash), required permission, reason. Approval is invalid if the payload changed. Execution is idempotent (keyed by request ID). Rules R3 (no self-approval when others can approve) apply.

Actions that always require approval or an equivalent in-session authorisation: refunds, stock adjustments/write-offs/corrections, purchase posting proposed by an agent, invoice cancellation by non-owner, tax settings change (re-auth), bulk marketing send, social publishing, ad spend, integration credential changes (re-auth), plan purchases.

## 12. Agent run

`QUEUED → RUNNING → COMPLETED | FAILED | CANCELLED | LIMIT_REACHED | AWAITING_APPROVAL`; `AWAITING_APPROVAL → RUNNING` (after decision) or `COMPLETED`.
