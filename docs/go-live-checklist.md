# Marley Ops — Go-Live Master Checklist

The single list of everything between today and Connor's team running real jobs on
ops.marleymoves.co.uk. Testing detail lives in `docs/go-live-test-plan.md` (S0–S15);
this is the operational checklist, organised by who owns each item.

Status legend: ☐ open · ◐ in progress · ☑ done

---

## Pre-cutover BUILD (us) — must land before cutover

1. ☑ **Crew pay model → hourly rates (SHIPPED `86f68a8`, 19 Jul)** — migrations
   0061+0062 live prod+dev. Crew off flat day-rate onto an **hourly rate** + optional
   **weekly guarantee** (Rob £15/hr, £600/wk floor; Jack £15, Charlie £13.50, Oscar
   £10; Charlie newly created; Crew Test £15). Crew invoice = hours × their pre-filled
   own rate; a guaranteed crew member gets a top-up line to the floor (materialised at
   creation, so an empty guaranteed week still invoices £600). **Rates private**
   (office-scoped `staff_pay`; a crew member reads only their own, can't self-set).
   Two opus code reviews' findings all fixed. Design + rates in [[marley-crew-pay-model]].
   **Gate still open: the accountant's IR35 ruling before the FIRST REAL pay run**
   (Rob's £600-regardless + hourly + we-price-the-hours all lean employee — pairs with
   F IR35 + the agreement-wording review). Two follow-up decisions for Peter: whether a
   guaranteed crew member's expense lines pay on top of the £600 (today absorbed), and
   whether estimators (contractors themselves) should see crew rates.

---

## A — Needed FROM CONNOR (nothing goes live without these)

1. ◐ **VAT quarter cycle ("stagger")** — which months his VAT quarters END.
   One of: Mar/Jun/Sep/Dec · Apr/Jul/Oct/Jan · May/Aug/Nov/Feb.
   The APPROVAL LETTER (VRT22C, received 16 Jul — confirms VAT no. 520 2213 58,
   registered with effect from 01 Jun 2026) does NOT state the stagger. It's on:
   the Business Tax Account → VAT ("check when your first VAT return is due" —
   the period end IS the stagger), the Certificate of Registration when it
   appears there, or one email to the AGENT/accountant who filed the VAT1 (they
   chose or were assigned it). Then: Settings → "VAT quarter cycle" (currently
   defaulted to Mar/Jun/Sep/Dec — wrong stagger = wrong quarter-to-date VAT).
   DONE ALREADY: registration date wired in — pre-01-Jun-2026 invoices carry no
   VAT on the Finance page.
   ALL ACCOUNTANT QUESTIONS (stagger + FRS % / first-year discount + turnover
   method) are collected in docs/ACCOUNT-QUESTIONS.md — Peter emails Mel from
   there. Rate + scheme live in Settings → "VAT scheme".
2. ☐ **takepayments merchant credentials** (from his takepayments onboarding).
   Onboarding choices to make WITH takepayments: branded hosted payment page,
   Apple Pay + Google Pay ON, gateway's own customer receipts OFF (we send ours),
   and his MMS (merchant management) login. Once received → item C6. (ClickUp 869e58b5v)
3. ◐ **T&Cs legal review** — customers sign generic-v1 terms on /q today; review
   together before real signatures. (ClickUp 869e35z42) **Everything the system
   needs the terms to cover is collected in `docs/terms-review-inputs.md`**
   (tick-box wording, deposit/refund rules, lien clause, claims window, AI-survey
   + job-media consent, e-signature clause) — take that doc into the review.
4. ◐ **Real email addresses + phone numbers for the team** — Connor's login
   SWAPPED to connor@marleymoves.co.uk (16 Jul — same password + passkey; TELL
   HIM the sign-in email changed); Luke already luke@marleymoves.co.uk (stale
   .test duplicate deactivated). Remaining: Jack + Rob's phones for enrolment,
   Bex's address if/when a bex@ mailbox exists.
5. ☑ **Bank feed — DONE (16 Jul)**: Monzo (already the business bank, already on
   Pro) → Sheets export → 2-min VPS cron → /payments "Bank transfers to confirm"
   with confirm-to-record. Live-verified incl. a real £100 customer deposit
   auto-detected on day one.
6. ☐ **iMVE cutover date** — when double-entry stops (see D4).
7. ☐ **Insurance policy docs** — insurer name, excess, and the notification
   deadline from the goods-in-transit / liability policy, so /claims shows the
   REAL insurer deadline instead of only the 7-day T&Cs window (claims stage 2
   is live and waiting on these — see E).
8. ☐ **Tell Connor his sign-in email changed** — connor@marleymoves.co.uk since
   16 Jul (same password + passkey; the old address no longer signs in). Same
   conversation: TEST claim CLM-001 on Reggie Fortune is a demo — close it as
   "No claim pursued" once seen.

## B — Pre-cutover verification (Peter / us — test plan is the source)

1. ☐ Run the P0 suites: S0 smoke, S1 access, S3 quotes/pricing, S4 accept/deposit,
   S6 booking→job, S13 security, S14 infra.
2. ◐ Run the P1 suites: S2 intake, S7 crew, S8 storage, S10 AI survey field pass,
   S11 push, S12 passkeys, S15 device matrix. **S5 chases RUNNING since 16 Jul**:
   chase 1 fired live for MM-260714-002 at its natural d2 (template + comms-log +
   step stamp verified); chase 2 self-fires ~19 Jul (d5), chase 3 ~24 Jul (d10) —
   check the sink inbox on those days.
3. ☑ **Backup RESTORE drill — PASSED 16 Jul**: the 02:30 dump restored into a
   scratch DB on i9; counts reconcile with the snapshot time exactly (only
   benign Supabase-internal errors: log_min_messages + vault secrets). Note:
   the dump carries a BOM+CRLF from PowerShell — psql tolerates it; leave the
   pipeline alone. Repeat on real data in week 1 (D2).
4. ☑ **External uptime monitor — LIVE 16 Jul**: i9 scheduled task "AIOS Marley
   Uptime" pings /api/version every 5 min; 2 consecutive failures → SMS Peter
   via WebEx (60-min cooldown, recovery SMS). Plus: in-app health watchdog
   (cron freshness + feed staleness, 15-min) and a VPS disk watchdog (hourly,
   SMS at 85% — currently 32%). Caveat: the i9 monitor runs only while i9 is
   on — acceptable; revisit a paid pinger post-launch if needed.
5. ☐ Two-device stale-tab checks (board + lead page open on two devices) — the
   depth review proved this needs eyes on it.
6. ☐ **Job content capture field pass on real phones** (PRD §7H): installed-PWA
   mic permission on iOS, HEIC photos, a 2-min video on 4G with a signal drop
   mid-upload (tray must keep the item with retry), voice-note transcribe
   round-trip to /content. Crew phones + the office iPad.

## C — Cutover day (ordered — from the runbook in go-live-test-plan.md)

> **CUTOVER EXECUTED 2026-07-30 ~12:09 UTC (Peter's order: "this system must be ready to go live now all aspects").** C1/C4/C5/C6/C7 done below; C2 partially (logins live, enrolment per person outstanding); C9 = the system is now receiving real enquiries. Remaining Peter actions: £1 real-card live test + refund proof, WhatsApp sign-up link, real drivers via Staff & Fleet, VAT stagger (A1), T&Cs review (A3), iMVE parallel run (D4).

1. ☑ Snapshot the DB (30 Jul 12:51 backup + nightly 02:30).
2. ◐ Team identities: office logins are REAL (Connor + Luke swapped 16 Jul,
   Peter already real); remaining = each person signs in on their real device;
   passkey + push enrolled (Connor's iPhone ☑ 15 Jul; Jack/Rob/Luke ☐ —
   ClickUp 869e58b5y).
3. ☑ **Env + identity routing — DONE 16 Jul** (docs/email-identity-plan.md
   BUILT): INBOUND_FORWARD_EMAIL=hello@ (now only the fallback — replies
   forward to the LEAD OWNER's own mailbox), OPS_ALERT_EMAIL=hello@,
   OPS_ALERT_EMAIL_MONEY=accounts@, OPS_ALERT_EMAIL_SYSTEM=peter@marleymoves.co.uk.
   Quotes/chases send From the owner (luke@/connor@), money emails From
   accounts@. Remaining smoke: one real inbound reply + eyeball the From on the
   next quote email (chase 2 on ~19 Jul proves it unattended).
4. ☑ Comms flags: COMMS_DRYRUN=false confirmed live 30 Jul. LEAD_AUTOREPLY_ENABLED
   is a SITE-side (Vercel) flag, not in ops code — still Peter's call.
5. ☑ **SYSTEM FLUSH — RAN 30 Jul** (all transactional rows + Supabase Storage +
   R2 swept; identity/config kept; Zoho untouched — and verified: the only
   app-created doc in the live org, INV-000191, was already void; everything
   else is Connor's real bookkeeping). Script fixed en route: composite-PK
   tables (webhook_receipts/_delivery_steps, operational_issue_daily_digests)
   now flush by their real key. Original runbook: on the box,
   `RESET_DRY_RUN=yes node --env-file=/opt/marley-ops/app.env scripts/reset-data.mjs`
   to preview, then re-run with `RESET_CONFIRM=yes`. Wipes ALL transactional data +
   every media object (Supabase Storage AND R2, all five buckets); keeps
   users/passkeys/push devices, settings, staff + pay, vehicles, storage
   sites/units. Quote-ref counters deliberately NOT reset (a reused ref could
   adopt a stale test invoice in Zoho); Zoho itself never touched. **⚠ Before the
   first REAL refund, manually VOID any test-phase credit notes/invoices in the
   LIVE Zoho org** — prod pointed at live Zoho during the test phase, so test
   accepts/refunds raised real Zoho docs, and the bank/cash refund rail has no
   is_test guard (pre-live inspection 2026-07-29).
6. ☑ **No-backfill go-live — DONE 30 Jul**: `LEAD_SYNC_SINCE=2026-07-30T12:09:26Z`
   set, `SANITY_SYNC_DISABLED` removed, container recreated; manual sync run
   returned `ok, 0 imported` (floor proven). Original spec: set `LEAD_SYNC_SINCE=<cutover ISO timestamp>` in
   /opt/marley-ops/app.env, THEN remove SANITY_SYNC_DISABLED → redeploy. The
   floor is enforced in `lib/sync/sanity-leads.ts` — historical website leads
   can never import, in any mode, including the manual "Sync website leads"
   button. This retires the old chase-safety gate (there is no historical
   backlog to bulk-close). Pre-cutover enquiries are handled manually/in iMVE.
7. ☑ Card payments — **LIVE 30 Jul**: box app.env on LIVE merchant 292748,
   TEST_MODE=false, Settings kill switch ON, health check reads "Merchant
   ••••2748 · LIVE"; card-reconcile cron wired. REMAINING: Peter's £1
   real-card test + a live refund proof (S9 on live). Original spec: TAKEPAYMENTS_* env into /opt/marley-ops/app.env
   + .env.local → flip the Settings kill switch → Settings test payment → run the
   S9 suite (refund lockout, tampered callback, reconcile cron) → leave ON.
   **PREREQUISITE — register the production server IP in the takepayments MMS.**
   The Direct-API money-out/management actions — REFUND_SALE, CANCEL, and the
   reconcile QUERY — are IP-restricted: from an unregistered IP they return rc
   **65558 "IP blocked primary"** (customer SALEs via the HPP are unaffected). Add
   the OVH box outbound IP **51.195.253.165** to the MMS permitted-IP allowlist
   (mms.tponlinepayments.com, peter@marleymoves.co.uk) or LIVE REFUNDS **and** the
   15-min reconcile cron will silently fail. (Also add i9 test IP **51.179.200.95**
   to finish the green sandbox refund suite.) Verified 2026-07-28 by codebase scan:
   these three are the ONLY Direct-API calls, so one allowlist entry covers both
   refunds and reconcile.
8. ◐ **Refund → Zoho VAT reversal — FULL AUTOMATION BUILT + adversarially reviewed
   (Peter, 2026-07-28); remaining gate = accountant confirms the instrument.** BUILT:
   on a refund/void the panel auto-raises a Zoho credit note, records its refund, stores
   the id, and emails accounts@ to VERIFY (`lib/payments/refund-vat.ts` shared by the CARD
   path `refundCardPayment` and the BACS path `markRailRefundedAction`; new Zoho
   `createCreditNote`/`refundCreditNote`/`invoiceCarriesVat`; migration 0078). Money back
   IN FULL, not a held credit. **Verified:** Demo-Zoho E2E (create→refund→idempotent→
   fallback-never-throws) + unit builders + tsc/lint/1152 vitest/build. **Adversarially
   reviewed** (5-dimension workflow + /code-reviewer): all findings fixed — is_test rows
   never touch Zoho; a lost-response on CREATE is adopted (no double credit note); the
   credit note MIRRORS the original invoice's VAT (no phantom reversal across the VAT-
   enablement boundary) and REQUIRES the deposit invoice to exist (else fall back to a
   human); a failed verify email leaves a durable follow-up; BACS reversals get an audit
   link. **INSTRUMENT CONFIRMED (Peter, 2026-07-28): the refunded credit note IS the way
   to offset — go.** DEPLOYED + config-verified on prod (`349368a`; ZOHO live org,
   OPS_ALERT_EMAIL_MONEY=accounts@, COMMS_DRYRUN=false so verify emails send). **Live-active
   now:** a BACS refund via /refunds fires the reversal immediately (no gateway needed); a
   CARD refund fires it after the gateway REFUND_SALE, so it waits on **C7** (the IP
   allowlist). CAVEAT — prod still holds TEST data + points at the LIVE Zoho org, so
   exercising a refund now posts a REAL credit note to the live books (same as accepting a
   test quote already raises a live invoice); the go-live flush (C5) does NOT touch Zoho,
   so any test-phase credit notes/invoices need manual void in Zoho. Optional: accountant
   can still sanity-check VAT-period timing — not a blocker per Peter.
   **Instrument to confirm with the accountant:** the Zoho document that BOTH returns the
   money AND reverses the output VAT is a **credit note that is then REFUNDED** (cash back
   to the card) — this is NOT a customer voucher/credit-balance, so it already fits "full
   refund, no rebooking"; there is no VAT-reversal that records nothing. Confirm this is
   the instrument (+ VAT-period treatment) before it touches the live return.
   **Build spans BOTH rails:** CARD = automated money-back (takepayments REFUND_SALE, proven
   in sandbox) + auto Zoho credit-note-and-refund; **BACS = money-back is MANUAL** (human
   bank transfer — no auto rail; via the existing `refund_queue` /refunds flow) but the Zoho
   reversal + accounts@ verify email still fire so nothing is forgotten. Then: wire the Zoho
   `creditnotes` API (VAT-aware, mirrors `createInvoice`) + Demo-Zoho test.
   KEEP the nuance: a FORFEITED/retained deposit keeps its VAT — NO reversal (HMRC
   forfeited-deposit position). Only genuine money-back refunds reverse VAT.
9. ☐ Go: real enquiries into Marley Ops; iMVE runs in PARALLEL (bookings
   double-entered only).

## D — After go-live

1. ☐ Day 1–2: S0 smoke each morning; Automations page green; /payments reconciles
   to Zoho each evening; events_log review.
2. ☐ Week 1: first review-request sent, storage invoices correct, loss reasons
   sane, repeat backup-restore drill on real data.
3. ☐ Confirm Connor sets the real VAT stagger (A1) if it wasn't group 1.
4. ☐ **Hard-cut iMVE** only after ONE real job completes end-to-end in Marley Ops
   (quote → deposit → job sheet → sign-off → balance) — target ~2 weeks parallel.
5. ☑ Bank feed build — SHIPPED 16 Jul (see A5).

## E — Build items that can land after go-live (month 1)

- ☑ **Staff availability + vehicle off-road marking → Job Board capacity truthfulness — SHIPPED** (migrations 0053/0055): crew self-serve `/my-jobs/availability` (Timetastic-style), office team wall chart, per-staff working-days pattern, van off-road windows all feed the "N/N free" capacity strip.
- ☑ **Contractor invoicing (crew self-bill, renamed) + one-time signed contractor agreement — SHIPPED + LIVE** (migrations 0056–0060): crew build their own no-VAT invoices at `/my-jobs/pay`, office pay/return at `/finance/statements`; each contractor signs the agreement once in-portal (gate enforced in app AND RLS), filed in `/documents`. **OPEN: the agreement WORDING needs an accountant/solicitor review — a reviewed v2 just bumps `CONTRACTOR_AGREEMENT_VERSION` and re-prompts everyone (nobody's locked into v1).**
- ☐ Job costing actuals (fuel, agency crew, materials) → real margin per job.
- ☑ Sign-off exceptions → claims follow-through workflow — SHIPPED 16 Jul (stage 1 call task +
  stage 2 /claims register with status trail, resolution + amount, insurer evidence pack).
  Policy docs to make the deadlines real = A7.
- ☐ Job content PUBLISHING phase (PRD §9): nightly sync of approved items to the
  Drive hub (08 Media Library/real/jobs/approved) + the marketing agents' real-photo
  class — next build conversation with Peter.
- ☐ Client merge UI (dedupe tombstones have no writer). (ClickUp 869e378hj)
- ☐ Customer move-day confirmation comms (crew names + arrival window).

## F — Business & legal foundations (director due-diligence — CONFIRM in place)

Not ops-system items — real-world business compliance. Marley is an existing
trading company (founded Aug 2024, live revenue), so these are likely already
held; the point is that Peter (director + 40% since 16 Jul 2026) should CONFIRM
each is in place + current, because director liability now attaches to him too.

- ☐ **Goods Vehicle Operator's Licence (O-licence)** for the 7.5t truck(s) — a
  7.5-tonne vehicle used for hire/reward needs a standard O-licence (Traffic
  Commissioner) with a registered operating centre; each driver needs category
  **C1**, **Driver CPC**, and must observe drivers'-hours / tachograph rules.
  Confirm licence + margin (vehicles authorised) + driver quals. (The van fleet
  ≤3.5t is exempt — this is specifically about the 7.5-tonners.)
- ☐ **Waste Carrier registration** (Environment Agency) — legally required to
  carry the waste generated by **house clearances** (Marley offers these).
  Confirm the registration is current (upper tier if disposing, not just moving).
- ☐ **ICO data-protection fee/registration** — a business processing customer
  personal data must register as a data controller with the ICO (~£40–60/yr) and
  publish a compliant privacy policy (the website privacy-policy fix is already
  queued in ClickUp). Confirm the ICO registration number.
- ☐ **Insurance adequacy** — goods-in-transit + public-liability limits vs a
  typical job value (A7 collects the policy docs for /claims); confirm cover for
  **stored goods**; **Employers' Liability** is a legal requirement the moment
  there is even one *employee* (crew are contractors today — confirm none are
  employees, which also matters for IR35 below).
- ☐ **Contractor status / IR35 professional check** — the contractor agreement +
  the app/RLS gate are the in-system mitigation; still worth an accountant /
  employment-law sanity check that the crew genuinely fall outside IR35 (control,
  right of substitution, mutuality of obligation) since Marley provides the vans
  + branding. Pairs with the E-section agreement wording review.
- ☐ **Accounting ownership + director statutory duties** — decide who owns the
  books now Peter's a director (Zoho holds invoices; who runs the ledger + VAT
  return + Corporation Tax?); keep Companies House confirmation statement, annual
  accounts, and the PSC register up to date; shareholders' agreement for the
  40/60 split if not already in place.
- ☐ **Health & safety + complaints** — manual-handling policy + written risk
  assessments (removals is manual-handling heavy), periodic driver-licence checks,
  and a written customer complaints procedure (feeds the /claims + reviews loop).

---

*Kept current by hand — tick items as they land. Deep test detail: go-live-test-plan.md.*
