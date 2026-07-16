# Marley Ops — Go-Live Master Checklist

The single list of everything between today and Connor's team running real jobs on
ops.marleymoves.co.uk. Testing detail lives in `docs/go-live-test-plan.md` (S0–S15);
this is the operational checklist, organised by who owns each item.

Status legend: ☐ open · ◐ in progress · ☑ done

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
2. ☐ **takepayments merchant credentials** (from his takepayments onboarding).
   Onboarding choices to make WITH takepayments: branded hosted payment page,
   Apple Pay + Google Pay ON, gateway's own customer receipts OFF (we send ours),
   and his MMS (merchant management) login. Once received → item C6. (ClickUp 869e58b5v)
3. ☐ **T&Cs legal review** — customers sign generic-v1 terms on /q today; review
   together before real signatures. (ClickUp 869e35z42)
4. ☐ **Real email addresses + phone numbers for the team** — Connor (swap
   connor@marleymoves.test), plus Jack + Rob's actual phones for enrolment day.
5. ☐ **Bank decision (with Peter)** — Monzo Business Pro (£9/mo, live Sheets feed)
   vs Starling (£0, first-party API) for the /payments bank feed. (ClickUp 869e58b5x)
6. ☐ **iMVE cutover date** — when double-entry stops (see D4).

## B — Pre-cutover verification (Peter / us — test plan is the source)

1. ☐ Run the P0 suites: S0 smoke, S1 access, S3 quotes/pricing, S4 accept/deposit,
   S6 booking→job, S13 security, S14 infra.
2. ☐ Run the P1 suites: S2 intake, S5 chases (START EARLY — d2/d5/d10 timing needs
   days), S7 crew, S8 storage, S10 AI survey field pass, S11 push, S12 passkeys,
   S15 device matrix.
3. ☐ **Backup RESTORE drill** — restore the latest nightly dump into a scratch DB
   and count rows. Never done = no backup.
4. ☐ **External uptime monitor** — free pinger on /api/version, alert to Peter.
   Nothing currently alerts if the box dies out of hours.
5. ☐ Two-device stale-tab checks (board + lead page open on two devices) — the
   depth review proved this needs eyes on it.

## C — Cutover day (ordered — from the runbook in go-live-test-plan.md)

1. ☐ Snapshot the DB.
2. ☐ Team identities: swap `.test` emails → real (Settings → Team); each person
   signs in on their real device; passkey + push enrolled (Connor's iPhone ☑ 15 Jul;
   Jack/Rob/Luke ☐ — ClickUp 869e58b5y).
3. ☐ Env routing: INBOUND_FORWARD_EMAIL → hello@marleymoves.co.uk,
   OPS_ALERT_EMAIL → the office address; restart; test one inbound reply + one alert.
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
5. ☐ Bank feed build (once A5 decided) — £1 reference spike test first.

## E — Build items that can land after go-live (month 1)

- ☐ Staff holiday / vehicle off-road marking → Job Board capacity truthfulness.
- ☐ Job costing actuals (fuel, agency crew, materials) → real margin per job.
- ☐ Sign-off exceptions → claims follow-through workflow.
- ☐ Client merge UI (dedupe tombstones have no writer). (ClickUp 869e378hj)
- ☐ Customer move-day confirmation comms (crew names + arrival window).

---

*Kept current by hand — tick items as they land. Deep test detail: go-live-test-plan.md.*
