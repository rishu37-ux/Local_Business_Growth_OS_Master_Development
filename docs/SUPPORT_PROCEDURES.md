# Support procedures (Phase 10.3)

Version 1.0 — 2026-10-28. How the platform team supports shops. **Nothing here is staffed yet.** The contact channels, hours and people are placeholders until the user names them (see `COMMERCIAL_READINESS.md` #7). The technical controls this document relies on are implemented and tested (TR-0045).

## 1. Contact channels (to be filled in by the user)

| Channel | Address | Hours | Use for |
|---|---|---|---|
| Phone / WhatsApp | *to be named* | *to be named* | S1/S2 issues, sign-in problems |
| Email | *to be named* | *to be named* | Everything else, data requests |
| In-app | Notifications only (no chat yet) | — | Status messages to owners |

Never ask a shop for a password, a two-step code or a backup code, on any channel. Shops are told this in the onboarding guide.

## 2. Severity and response targets (proposed for the pilot)

| Severity | Examples | First response | Work |
|---|---|---|---|
| **S1** — data exposure or integrity | Another shop's data visible; wrong invoice totals; stock or ledger not reconciling; suspected account takeover | 1 hour during support hours | Continuous until contained; incident process (§6) |
| **S2** — cannot trade | Cannot sign in, cannot issue invoices, app down | 2 hours during support hours | Same day |
| **S3** — degraded | A report is slow, printing problem on one device, a screen error with a workaround | 1 working day | Planned fix |
| **S4** — question / request | How-to, feature request | 2 working days | Reply; backlog item if needed |

These targets are proposals. They are not an SLA until written into the terms (`COMMERCIAL_READINESS.md` #8).

## 3. Triage steps

1. **Identify the caller.** Check that the caller is a member of the business: the email on file, with a call-back to the business phone in the application. A caller who cannot be verified gets general help only. They get no business data and no account changes.
2. Record the ticket:
   - business ID;
   - severity;
   - what happened, when, on which device and browser;
   - the request ID shown with any error message (every error carries one).
   Never record passwords, codes, full card numbers or customers' personal data in the ticket.
3. Look up the request ID in the logs. Logs hold the request ID, route and outcome, and no secrets. This needs no access to the business's data.
4. If you need to see the shop's data to help, ask the owner to grant support access (§4). Never ask for their password.
5. Fix, reply, and close. Record the root cause for S1/S2.

## 4. Support access to a shop's data (FR-SUP-1 — implemented, TR-0045)

- The platform team **cannot** see a business's data by default. Platform roles have no access to tenant tables (TR-0002, TR-0008).
- Only the **owner** can allow access: **Billing and support → Support access**. They state a purpose (at least 10 characters) and choose 1, 4, 24 or 72 hours. 72 hours is the maximum, and the database enforces it. Granting needs a recent sign-in.
- While the access lasts, a platform admin with two-step verification can **view** the business through the normal screens and API:
  - only the view permissions;
  - no exports;
  - no owner-only actions;
  - every attempt to change something is refused (`SUPPORT_READ_ONLY`).
- **Every** request made under the access, including refused attempts, is recorded and listed for the owner under "What support did": time, screen, and whether a change was tried and refused. Queries and form contents are not recorded, because they may contain personal data.
- The access ends by itself at the chosen time, or at once when the owner presses **End access**.
- Support staff must only open what the stated purpose needs. Opening anything else is a disciplinary matter, and the owner can see it.

## 5. Account recovery

- **Forgotten password:** the shop uses "Forgot password". The reset link goes to the account's email; support cannot reset passwords.
- **Lost authenticator:** the user signs in with a backup code and enrols again.
- **Lost authenticator and backup codes:**
  - Recovery needs an identity check: the owner on a video call with ID matching the application, plus a call-back to the registered phone.
  - Then two platform admins agree, and one resets two-step verification (there is no screen for this yet; it is an operator procedure under audit).
  - Record who checked and how.
- **Owner leaves the business:** the business must name a new owner in writing, verified as above, before any transfer. There is no transfer screen yet.

## 6. Incidents

Follow `DEPLOYMENT_RUNBOOK.md` §6: detect → triage → contain → communicate → recover → review.

For S1:
- Contain first: disable the feature or integration, revoke sessions, rotate credentials.
- Then inform the affected shops.
- Legal notification duties (CERT-In timelines, DPDP Act) must be confirmed with counsel before the pilot. They are **not verified here**.

## 7. Data requests from a shop

| Request | How | Who |
|---|---|---|
| Copy of all business data | Owner: **Overview → full data download** (ZIP of CSVs) | Owner themselves |
| A customer asks for erasure | Owner: customer page → **erase personal data**, with a reason. Invoices keep the legally required snapshot. | Owner (the shop is the data controller for its customers) |
| Close the business account | Written request from the owner. Data retention after closure is to be set with counsel (NFR-12). | Platform admin, after verification |

## 8. Never

- Never ask for or accept passwords, two-step codes, backup codes, card numbers or API keys from a shop. If a shop sends one, tell them to change it.
- Never change a shop's records directly in the database. Corrections are made by the shop through reversal records (`DEPLOYMENT_RUNBOOK.md` §5).
- Never use real customer data in tests or demos.
- Never promise that the system is "100 % secure" or legally compliant.
