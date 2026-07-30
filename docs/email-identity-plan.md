# Email identity & routing plan — Marley Ops

**Status: BUILT + LIVE (2026-07-16, commits `7d71cc3` + `297814c`).** Peter approved
same day: all six mailboxes confirmed on IONOS, reply forwards OWNER-ONLY, review
requests + deposit chases from the owner, alert split as proposed (system → 
peter@marleymoves.co.uk). Connor's ops login swapped to connor@marleymoves.co.uk
(same password/passkey); stale luke@marleymoves.test deactivated. Hardened by a
27-agent adversarial review — headline fix: ONE canonical owner rule
(`leadOwnerIdentity` in lib/comms/sender.ts: leads.estimator_id → survey-derived
estimator → quote creator) now drives the outbound From AND the inbound reply
forward, so the person fronting a thread always receives its replies. moves@ →
alias-to-hello@ is a manual IONOS step still open.
Grounded in a full inventory of all 45 send call sites (4-reader + completeness-critic
workflow, 0 gaps found). This document is the single reference for *which address every
email comes from, where replies go, and who gets told* — the v2 answer to the v1
quotes-app problem where everything funnelled to one mailbox and Connor received
correspondence for Luke's quotes.

---

## 1. The problem

- **v1 quotes app**: one sender, one BCC — Connor receives replies for quotes Luke sent.
- **marley-ops today**: every email effectively sends as `hello@marleymoves.co.uk`
  (chases personalise only the *display name* — "Luke at Marley Moves &lt;hello@…&gt;").
  Customer replies route through the tokenized `q-<token>@reply.marleymoves.co.uk`
  address into the panel (chase paused, Comms-logged, follow-up raised) and are then
  forwarded to **one global mailbox** (`INBOUND_FORWARD_EMAIL`) — so whoever owns that
  mailbox sees everyone's replies. Same disease, different organ.
- Money emails (receipts, invoices) carry no distinct financial identity, and no one is
  emailed when a payment lands (ops alerts default to Peter's RBS address).

## 2. The two principles

1. **Role addresses for functions, personal addresses for relationships.** This is how
   established firms run mail: `hello@` is the front door (monitored by the whole
   office), `accounts@` is the money desk, and the person who owns the customer
   relationship writes from their own name. Personal mailboxes never become the only
   copy of anything business-critical.
2. **The panel stays the system of record.** Reply-To on every lead-linked email stays
   the tokenized relay — that is what pauses chases, logs the reply on the lead, and
   raises the follow-up task *even when the owner is on holiday*. We change **who the
   relay forwards to**, not the relay itself.

> ⚠️ **Why not just set Reply-To to luke@ directly** (the intuitive fix): a customer
> reply would then bypass the panel completely — the chase engine wouldn't pause (the
> customer says "yes, book me" and still gets chase 2 three days later), nothing lands
> on the lead's Comms tab, no follow-up is raised, and coverage during holidays
> disappears. The relay is invisible to the customer and is doing real work — keep it.

## 3. Address roles

| Address | Role | Monitored by |
|---|---|---|
| `hello@` | Front door: new enquiries, general/unowned sends, fallback identity, site auto-reply | Whole office (Connor + Luke + Peter) |
| `accounts@` | Money desk: invoices, receipts, refunds, storage billing, payment notifications | Connor (+ bookkeeper later) |
| `connor@` / `luke@` | Personal sales identity: quotes, chases, deposit requests, their leads' reply forwards | The individual |
| `peter@` | System-failure alerts (Zoho errors, AI job deaths, card pipeline faults) | Peter |
| `moves@` | **Retire from sending.** Keep as receiving alias forwarding into `hello@` (historic contacts/listings) | — |
| `quotes@` | Not in the target set — two stale hardcodes still send as it (completion certificate, storage invoice); fix to the new identities | — |

Sender identity derivation: **a team member's sending address = their login email**
(`profiles.email`) when it ends `@marleymoves.co.uk`, else `hello@`. Luke's login is
already `luke@marleymoves.co.uk`; Connor's swaps from `connor@marleymoves.test` at the
already-scheduled go-live step. No schema change, no new Settings UI.

## 4. Per-email matrix (current → proposed)

**Sales relationship — From the lead OWNER** ("Luke at Marley Moves &lt;luke@marleymoves.co.uk&gt;", fallback "Marley Moves &lt;hello@&gt;" when unowned/inactive). Reply-To: tokenized relay → forwarded to the owner.

| Email | Current From | Proposed From |
|---|---|---|
| Quote email + re-send | hello@ (env default) | ~~Owner~~ **accounts@** (changed by Peter 2026-07-30 on go-live day — the priced offer fronts the money desk; replies still relay to the owner) |
| Quote chases 1–3 | "«Owner» at Marley Moves &lt;hello@&gt;" | **Owner** (display AND address) |
| Deposit request on accept + deposit chases 1–2 | same as chases | **Owner** (the customer said yes to *them*) |
| Survey confirmation | hello@ | **Owner** (hello@ if none yet) |
| Review request | hello@ (hardcoded) | **Owner** (a personal ask converts better) |
| Follow-ups "Message" dialog | hello@ | **Owner** |
| Office compose (ad-hoc) | hello@ (hardcoded) | **The logged-in sender's own identity** (we know the actor) + add the missing tokenized Reply-To |

**Money — From "Marley Moves Accounts &lt;accounts@marleymoves.co.uk&gt;"**. Reply-To: tokenized relay where a quote token exists (so chase-pause/logging still works), direct `accounts@` where none does.

| Email | Current From | Proposed From |
|---|---|---|
| Deposit received ("you're booked in") | hello@ | **accounts@** |
| Balance (final) invoice | hello@ | **accounts@** |
| Balance received ("all settled") | hello@ | **accounts@** |
| Storage recurring invoice | **quotes@ (stale hardcode)** | **accounts@** (direct Reply-To accounts@ — no quote token) |
| Card refund / void confirmation | hello@ | **accounts@** |

**House / operational — From "Marley Moves &lt;hello@&gt;"** (unchanged unless noted).

| Email | Note |
|---|---|
| Completion certificate (+ 48h check-your-items, + office re-send) | fix **quotes@ → hello@**; add tokenized Reply-To (currently plain hello@) |
| Cubic survey link (/cv), storage signing link (/s) | stays hello@ (v1 simplicity) |
| Site lead auto-reply + site lead alert | unchanged (hello@ / leads@→hello@) |
| Crew night-before reminder | unchanged (internal) |
| Fallback chase HTML signature | replace the hardcoded "Peter Farrell / Director / peter@" block with the owner-driven identity |

**Internal alerts — routed by category** (today: everything → `OPS_ALERT_EMAIL` → Peter's RBS address):

| Category | Recipient |
|---|---|
| Money events: deposit paid, balance paid, deposit-sent self-report, double payment, card mismatch/orphan, cancellation-with-money, balance overdue after move | **accounts@** (env `OPS_ALERT_EMAIL_MONEY`) — *this delivers Peter's "accounts@ should also receive an email"* |
| Business events: quote accepted/declined, customer replied, storage agreement signed, cubic survey received | **hello@** (env `OPS_ALERT_EMAIL`, the existing go-live swap) |
| System failures: Zoho API errors, AI job deaths, chase-engine errors, card pipeline exceptions | **peter@marleymoves.co.uk** (env `OPS_ALERT_EMAIL_SYSTEM`) |

## 5. Inbound routing

**Today**: reply → relay webhook → chase paused + Comms log + follow-up (assigned to the
quote's estimator) + forward to ONE global mailbox + ops alert. Two gaps: the forward
ignores ownership, and mail to the reply domain whose token doesn't resolve is
**silently dropped** (acked 200, no log, no forward).

**Proposed**:
1. **Forward to the OWNER'S mailbox** (quote's estimator → `profiles.email`), fallback
   `hello@` when unowned/inactive. The forward already sets Reply-To to the customer, so
   Luke replies from his own mailbox directly — exactly the "return address luke@"
   experience Peter described, without losing the panel pipeline.
2. **Catch-all**: unresolvable inbound to the reply domain forwards to `hello@` with a
   "couldn't match this to a job" banner (loop-guard: never forward mail originating
   from our own domains).
3. Ops alert "customer replied" stays (→ hello@ under the category routing).

**Coverage when someone is unavailable** (Peter's "what do companies do" question):
- **Shared front door**: `hello@` and `accounts@` are role mailboxes the whole office
  can open (IONOS webmail/phone mail apps) — new enquiries never depend on one person.
- **The panel is the safety net for owned threads**: every reply raises a follow-up
  visible to ALL office users on the Follow-ups queue and dashboard needs-action —
  Connor sees Luke's unanswered reply as an open task even though the email forward
  went to Luke. Personal forwards are a convenience copy, never the only copy.
- **Deterministic fallback**: a member marked inactive in Settings → Team instantly
  drops out of sending/forwarding — their leads' mail becomes hello@ both ways. No new
  "out of office" UI needed in v1.
- **Month-1 hardening (optional)**: escalate any `inbound_reply` follow-up still open
  after N business hours — push notification + hello@ email.

## 6. What this deliberately does NOT change

- The tokenized reply relay, the duplicate guard, the chase engine, all Resend
  templates (request-level From overrides the template's), and the site repo.
- The v1 quotes app: not worth retrofitting — the marley-ops cutover retires it. If
  cutover slips badly, a one-line per-estimator `reply_to` in `send-quote.js` is the
  stopgap.
- Deliverability: the Resend-verified apex covers ALL these From addresses via DKIM —
  zero DNS work. (Post-launch nicety: add `rua=` reporting to the `p=none` DMARC, then
  consider `p=quarantine`.)

## 7. Prerequisites (Peter/Connor, before build)

1. **Confirm the mailboxes exist and are accessible**: `accounts@`, `luke@`, `connor@`
   (create in IONOS if missing) — and that `hello@` + `accounts@` are set up on the
   phones of everyone who should watch them. Send a test mail to each; a From address
   whose mailbox doesn't exist means customer replies to a dead letterbox.
2. Decide who owns `accounts@` day-to-day (assumed Connor).
3. Confirm `moves@` becomes a receiving alias → `hello@` (no sending).
4. Connor's ops login swap `connor@marleymoves.test` → `connor@marleymoves.co.uk`
   (already on the go-live checklist — becomes his sending identity too).

## 8. Implementation phases (after sign-off)

| Phase | Work | Size |
|---|---|---|
| A | `lib/comms/sender.ts` (owner→From helper + accounts identity + alert-category routing); env vars `OPS_ALERT_EMAIL_MONEY` / `_SYSTEM`, `ACCOUNTS_EMAIL` | S |
| B | Wire owner From: chases (incl. owner-email lookup + the survey-derived-owner fallback the cron currently misses), quote send, deposit request, survey confirmation, review request, follow-ups dialog, compose-as-actor (+ its missing tokenized Reply-To) | M |
| C | Money From accounts@ (5 emails) + fix the two `quotes@` hardcodes + certificate Reply-To | S |
| D | Inbound: owner-routed forward + unresolvable-inbound catch-all + loop guard | S |
| E | Ops-alert category routing (single choke point in `sendOpsAlert`) | S |
| F | Fallback chase signature de-Peter'd; template registry `from` fields updated to match (cosmetic) | S |
| G | Tests + live send matrix to the sink (every email type: From/Reply-To assertions + a real reply round-trip proving owner forwarding) | M |

## 9. Open decisions for Peter

1. Review request from the **owner** (recommended — personal ask) or from hello@?
2. Alert routing split (money→accounts@, business→hello@, system→peter@) — approve, and
   which peter@ for system alerts: `peter@marleymoves.co.uk` (recommended) or the RBS one?
3. Deposit chases from the **owner** (recommended — the relationship is theirs and the
   copy is written in their voice) or from accounts@ (stricter money separation)?
4. Should the reply forward ALSO CC hello@ for full-office visibility, or owner-only
   (recommended — the panel's follow-up queue already gives shared visibility, and
   owner-only is exactly what fixes the "Connor gets Luke's email" complaint)?
