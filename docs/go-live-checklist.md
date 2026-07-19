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
3. ☐ **T&Cs legal review** — customers sign generic-v1 terms on /q today; review
   together before real signatures. (ClickUp 869e35z42)
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

1. ☐ Snapshot the DB.
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
4. ☐ Comms flags: COMMS_DRYRUN=false confirmed; decide LEAD_AUTOREPLY_ENABLED
   (still gated off — Peter reviewing the template).
5. ☐ Data reset: `reset-data.mjs` clears test leads/quotes/comms/appointments —
   verify staff, fleet, settings, templates and real storage records survive.
6. ☐ Backfill: remove SANITY_SYNC_DISABLED → redeploy → "Sync website leads".
   **⚠ THEN IMMEDIATELY the chase-safety gate: bulk-close dead historical leads
   BEFORE the next chase cron tick** — the single biggest cutover risk (old
   enquirers getting chase emails on day one).
7. ☐ Card payments (when A2 lands): TAKEPAYMENTS_* env into /opt/marley-ops/app.env
   + .env.local → flip the Settings kill switch → Settings test payment → run the
   S9 suite (refund lockout, tampered callback, reconcile cron) → leave ON.
8. ☐ Go: real enquiries into Marley Ops; iMVE runs in PARALLEL (bookings
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
