# Marley Ops — Production Go-Live Test Plan

Target: production cutover week of 2026-07-20. This is the manual/UAT layer on top of the
automated gates (506 vitest + lint + tsc + build in CI, auto-rollback on failed health check).
Automated tests prove the code; this plan proves the *business* works on the live system.

## How to run this plan

- **Environment:** everything runs against https://ops.marleymoves.co.uk (prod holds mock/test
  data until cutover, so testing there is safe and is the only environment that exercises the
  real Supabase, Caddy, cron, Zoho, Resend, WebEx and push stack).
- **Test sink:** all test emails/SMS go to peter@abacusonline.net / 07572382366. NEVER send to a
  real customer address. NEVER use lukecdjames1@gmail.com (a real contact).
- **Logins:** Peter (office) peter@marleymoves.co.uk · Connor connor@marleymoves.test (swap to
  real at cutover) · Luke luke@marleymoves.co.uk (estimator) · crew demo peter@abacusonline.net.
- **Recording:** tick each item, note FAIL with a screenshot + the build sha from the sidebar
  version stamp. A FAIL in a P0 suite blocks cutover; P1 blocks the affected feature only.
- **Priorities:** P0 = money, evidence, access control, cutover mechanics. P1 = core daily
  workflow. P2 = polish/edge.

---

## S0 — Smoke suite (P0 — run after EVERY deploy during launch week)

- [ ] `/api/version` returns the sha just deployed; sidebar version stamp matches.
- [ ] Sign in as office, estimator, crew — each lands on the right home (Dashboard / My day / My jobs).
- [ ] Dashboard renders with no console errors; needs-action cards populate.
- [ ] Open a lead, a quote, the Job Board, /payments — all render.
- [ ] Create + delete a throwaway manual lead.
- [ ] Send one test email (compose dialog → sink address) — arrives branded.

## S1 — Roles & access control (P0)

- [ ] Office sees all 7 nav groups. Estimator sees only the estimator nav. Crew has no sidebar.
- [ ] Crew hitting every dashboard route by URL (/, /leads, /quotes, /settings, /payments,
      /growth, /documents) is redirected to /my-jobs.
- [ ] Estimator hitting /growth, /automations, /resources, /storage, /documents by URL is denied
      (these are office surfaces; today the nav hides them — verify the server also gates them,
      not just the menu).
- [ ] Estimator Settings shows ONLY Quick sign-in + Notifications (no team, rates, kill switches).
- [ ] Crew RLS lockdown re-verified live: as crew, quotes / business_settings /
      estimator_payouts / storage_lets return 0 rows (browser network tab or a quick script).
- [ ] Deactivate a test profile → sign-in blocked, passkey assertion rejected, session invalidated.
- [ ] Sign out works from all three roles; deep links after sign-out land on /login.

## S2 — Lead intake, dedupe & alerts (P1)

- [ ] Add a lead via every channel: manual, phone (Google), phone (Facebook), phone (referral),
      referral — source stored + shown on the lead header and Performance per-source table.
- [ ] Add a second lead with the SAME phone number → attaches to the existing client, shows
      "N previous enquiries", repeat-client badge on Clients.
- [ ] Insert an `entry_channel='web'` lead (SQL or the seed script) → persistent banner + chime
      for ALL office users until one presses Acknowledge; crew/estimator never see it; push
      `new_enquiry` fires to enrolled office devices.
- [ ] Web-synced lead: attribution fields (gclid/utm/landing) visible and read-only.
- [ ] Cmd/Ctrl-K global search finds the lead by name, postcode and phone; the client by name;
      a quote by ref.
- [ ] Pipeline stepper on the lead shows the correct current stage; tapping the next stage
      routes to the recommended action.
- [ ] Mark a lead lost with a reason → unwind runs (future appointments cancelled, unpaid Zoho
      invoices voided, refund-decision task if money was taken) — verify in Zoho.

## S3 — Quotes & pricing (P0 — money)

- [ ] Build a quote from a lead: wizard pre-fills from the lead, live total updates per step.
- [ ] Hand-check ONE full quote against the pricing spec: base + pack + 7.5t + mileage (£2/mi
      3-leg) + access + floors×vans + congestion + £150 admin − discount, VAT 20% as the single
      final line. Must match the panel to the penny.
- [ ] New refs generate MMR###/MMC### (kind follows property size), strictly increasing, no
      collisions when two quotes are created near-simultaneously.
- [ ] Customer PDF: "Your Removal" single folded line (no van/crew counts anywhere), line items
      sum exactly to subtotal, VAT number 520 2213 58 in the footer, QR links to /q.
- [ ] Send quote → branded email + PDF to sink, status→Sent, chase engine status line appears
      ("Chase 1 of 3 …"), Comms row logged.
- [ ] Send the identical quote email again → duplicate guard warns; override requires a reason.
- [ ] Alternative-email send: differing address offers "Save as the lead's email" — ticked
      updates lead only; untick sends one-off; both logged on the timeline.
- [ ] Re-send on an ACCEPTED quote → status stays accepted.
- [ ] Reject a sent quote (required reason) → lead lost only if it was the last live quote.
- [ ] Price revision: accept a NEW quote for the same lead → old sibling retired, a PAID deposit
      carries over (no second deposit invoice), unpaid old invoice voided in Zoho.
- [ ] Cubic survey from the quote header: build volume → van recommendation → pre-selects
      vehicle on a new draft; customer /cv link works and locks after office completes.

## S4 — Customer accept page /q (P0 — money + evidence)

- [ ] Accept requires all 3 acknowledgment boxes; typed name renders as script signature and is
      stored as PNG with IP/UA + terms version.
- [ ] On accept: lead → provisional, £100 deposit invoice raised in Zoho (reference -DEP),
      deposit chase queued, ops alert sent, office push `payment_event` fires.
- [ ] The same URL now serves the payment view: BACS panel shows the quote ref; card button
      hidden while the kill switch is OFF.
- [ ] "I've sent the bank transfer" → reminders paused, check-the-bank task raised, chip on
      Bookings.
- [ ] Customer decline with reason → recorded, feeds loss stats.
- [ ] Token security: mangled token → 404; page is noindex; accepted quote can't be re-accepted.
- [ ] Hammer test: double-click accept / refresh-resubmit → exactly ONE signature row and ONE
      Zoho invoice (never-create-twice).

## S5 — Chase engine & comms (P1, timing-sensitive — start early in the week)

- [ ] Quoted chases fire at d2/d5/d10 from a lead OWNED by a named estimator: From reads
      "«First» at Marley Moves", intro "It's «Owner» here.", reply-to routes via
      reply.marleymoves.co.uk.
- [ ] Deposit chases fire d1/d3 after accept; wording says BOOKING (not move date) when no date
      is confirmed.
- [ ] Phone-only lead (no email) → call TASK raised instead of an email at each chase point.
- [ ] Move date passes mid-chase → email chases stop, one call task raised.
- [ ] Settled job >24h past move date → lead auto-completes + Google review request sent —
      UNLESS the crew sign-off recorded exceptions (review_suppressed) or the lead-page toggle
      is Off. Verify all three states of the control.
- [ ] Inbound reply to any chase → logged to Comms, chase paused, follow-up task created,
      forwarded to INBOUND_FORWARD_EMAIL.
- [ ] 30-day silent lead auto-lapses to lost ("no response").
- [ ] Spot-render every customer template to the sink (quote, chases ×3, deposit request,
      deposit chases ×2, deposit received, balance invoice, night-before, review request,
      completion certificate, storage invoice, signing link): branded shell, no broken vars,
      no "pinkish" legacy styling, correct sender + reply-to on each.
- [ ] SMS path: one WebEx send to 07572382366 arrives; logged with count.
- [ ] Duplicate guard blocks an identical ad-hoc email; override reason lands in the log.

## S6 — Booking → job (P1)

- [ ] Deposit paid via one-tap BACS (bank/cash picker) → lead confirmed, chase closed, branded
      deposit-received email, Bookings chip flips.
- [ ] Final invoice button: confirm dialog shows exact amount + recipient → Zoho invoice
      (agreed − deposit, reference -BAL) + branded email with the Zoho VAT PDF attached +
      balance chase queued for day-before-move. Re-click → NO second invoice.
- [ ] Job Board: assign crew + van by modal (iPad) and drag (desktop) → capacity strip
      decrements, traffic-light colours correct, clash on a double-booked van WARNS but never
      blocks, expired-MOT vehicle shows the compliance badge.
- [ ] Required-vs-assigned line derives from the accepted quote (e.g. "2 vans required") and
      flips green when met.
- [ ] Assignment fires `crew_job` push ONLY to the assigned member; removing them replaces the
      alert and re-buzzes.
- [ ] Reschedule to a new day: balance chase moves with the move date, night-before crew
      reminder re-arms, board reflects instantly.
- [ ] Cancel a booked job: future appointments cancelled, unpaid invoices voided, refund task
      raised when money was taken; crew's stale /my-jobs/[id] URL now 404s.

## S7 — Crew day (P1)

- [ ] /my-jobs shows ONLY the signed-in crew member's assigned jobs, grouped by day; week strip
      counts correct; "Your device" rows present (install, quick sign-in, notifications).
- [ ] Job page: route + access, crew-mates, vans, inventory, notes, survey photos + AI
      walkthrough videos inline (signed URLs), Directions links open Maps. NO prices anywhere.
- [ ] Job sheet PDF downloads on iPad AND desktop: price-free, survey photos page, QR to the
      job page.
- [ ] Crew adds a note + camera photo → office sees the Crew Notes card on lead + quote,
      timeline activity written; crew can delete own, office delete works.
- [ ] Unsigned accepted quote → amber "Collect signature now" banner → drawn signature on the
      tablet records an in_person contract identical to /q's.
- [ ] Completion sign-off: customer + crew signatures → certificate PDF stored + emailed, in
      /documents and on the client page. Customer-absent path → 48h check-your-items email.
- [ ] Sign-off WITH exceptions → review request auto-suppressed; office sees the flag.

## S8 — Storage (P1)

- [ ] Create site → unit (preset cu ft) → assign client → let opens; unit shows occupied;
      archive blocked while occupied.
- [ ] Storage agreement both channels: in-person (acks incl. lien clause + drawn signature) and
      remote /s/<token> (typed script signature). One per let; lands in Documents + client page.
- [ ] Set a rate → next 07:00Z cron raises the period invoice in Zoho (reference
      MMS-<let8>-<period>) + branded email w/ VAT PDF. Re-run the cron → 0 new invoices.
- [ ] Manage dialog: pause/resume billing; rate/start locks once invoiced; paid status refreshes
      from Zoho; Performance Storage tab reconciles Billed/Paid/Outstanding to the penny.
- [ ] End let → final period bills in full (no pro-rata), unit freed; "Reopen last let" restores.

## S9 — Card payments (P0 — run the DAY Connor's merchant creds land)

- [ ] With kill switch OFF: no card button on /q, no card UI anywhere.
- [ ] Add TAKEPAYMENTS_* to /opt/marley-ops/app.env + .env.local, restart, flip the Settings
      switch ON, run the Settings TEST payment → succeeds and is listed on /payments as a test
      (excluded from totals).
- [ ] Real flow on a test quote: /q "Pay by card" → hosted page → pay → signed callback settles
      via the deposit-paid pipeline (lead confirmed, chase closed, receipt email, push).
- [ ] Tampered callback (edit any signed field) → rejected, nothing settles.
- [ ] Refund: button locks the moment it's clicked (spinner, dialog can't close), double-click
      → exactly one refund; a second refund attempt on the same payment is server-blocked.
- [ ] Void an unsettled payment; /payments shows the void same-day netting to zero.
- [ ] cron/card-reconcile adopts an orphaned capture (simulate: pay, block the callback) within
      15 min.
- [ ] /payments day view: card receipts + refunds + recorded BACS deposits/balances reconcile to
      Zoho for the same UK day; day navigation across a month boundary; dedupe (card-paid
      deposit never double-listed as recorded).

## S10 — AI video survey (P1 — field validation, real iPad)

- [ ] Consent sheet → guided 2-min 720p clips on the REAL office iPad; whole-property import
      under the 500MB cap; TUS upload survives a deliberate network drop (toggle wifi mid-upload,
      resume completes).
- [ ] Drainer processes within ~2 min; detections map to valid catalogue keys; review → accept →
      merge sets planning_ready, +20% contingency, van pre-select updates.
- [ ] Spend ledger increments per analysis (~$0.02); /automations shows the run.
- [ ] Failure path is honest: kill the network during analysis → job fails with a visible error,
      no infinite spinner (bounded waits).
- [ ] ai_survey kill switch OFF hides the capture UI everywhere.
- [ ] Begin the 30-survey shadow log (docs/ai-survey-field-rollout.md) — AI estimate vs manual
      cubic on real jobs before trusting it for pricing decisions.

## S11 — Push & PWA (P1)

- [ ] Enrol one device per role (Connor iPhone done 15 Jul; Jack/Rob/Luke at cutover): install
      PWA, enable notifications, confirm a LOCK-SCREEN delivery (a 201 from APNs is not proof —
      eyes on the phone).
- [ ] Category routing: new_enquiry + payment_event → office only; crew_job → only the assigned
      member.
- [ ] Focused-app suppression defers to the in-app banner+chime — EXCEPT Apple endpoints, which
      always display.
- [ ] Global + per-category kill switches in Settings actually stop sends.
- [ ] Deploy a new build → "Update" banner appears on a stale open PWA within 5 min / on resume.
- [ ] Reinstall the PWA on one device → old endpoint retired, new endpoint enrolled (no ghost
      sends); 10-device cap + prune verified once real crew enrol.

## S12 — Passkeys & auth (P1)

- [ ] Register Face ID (iPhone), Android fingerprint, and a desktop platform key; each signs in.
- [ ] Revoke a device in Settings → its passkey stops working immediately.
- [ ] 10 failed assertions in an hour → rate-limited.
- [ ] Password fallback still works for every account; inactive profile rejected on both paths.

## S13 — Security spot-checks (P0)

- [ ] IDOR: as crew, replay getJobSheetDataAction (or any job/lead action) with ANOTHER job's
      UUID → denied. Repeat for a cancelled job's URL → 404.
- [ ] Signed URLs (survey photos, job docs, certificates) expire and are not guessable; the
      storage buckets reject unauthenticated direct GETs.
- [ ] Office-only server actions (refund, void, settings, final invoice, storage billing) fail
      for estimator/crew sessions — test at the ACTION layer, not just hidden buttons.
- [ ] /q, /cv, /s tokens: 404 on mangled tokens, noindex headers, no enumeration (sequential
      guesses fail).
- [ ] TLS: valid cert on ops.marleymoves.co.uk + supabase.redbananastudios.com; no mixed content.
- [ ] events_log captures the sensitive actions performed above (audit trail intact).

## S14 — Infra & operations (P0)

- [ ] **Backup restore drill**: take the latest nightly dump and restore it into a scratch
      database (`psql` into a temp DB on the VPS or i9); row-count leads/quotes/clients match
      prod. An untested backup is not a backup — do this BEFORE cutover.
- [ ] Cron inventory fires: chase engine, storage-billing (07:00Z), crew-reminders (17:00Z),
      zoho-deposits (15 min), card-reconcile (15 min), ai-jobs drainer (2 min) — check
      cron_runs/Automations page shows fresh green timestamps for each.
- [ ] Deploy pipeline: push a trivial change → CI test gate → build → health check → live sha
      changes; note the rollback command from docs/ovh-deployment.md and confirm the previous
      image tag still exists on the box.
- [ ] Env audit on /opt/marley-ops/app.env: VAPID pair, Zoho, Resend, WebEx, Gemini (base URL
      MUST include /v1beta), CRON_SECRET, OPS_ALERT_EMAIL, INBOUND_FORWARD_EMAIL. Screenshot the
      list (names only) for the runbook.
- [ ] Disk: ≥25GB free after a week of survey videos (retention cron is load-bearing — verify it
      deleted something).
- [ ] External uptime monitor pinging /api/version every minute with an alert to Peter
      (UptimeRobot free tier or similar) — currently NOTHING alerts if the box dies out of hours.
- [ ] Supabase auth + PostgREST containers restart-clean: `docker restart` the app container and
      confirm sessions survive.

## S15 — Device & browser matrix (P1)

Run S0 + one lead→quote→send loop on each:

- [ ] Office iPad (Safari, the real one used in the office) — including Job Board assignment
      and cubic survey touch targets.
- [ ] Connor's iPhone (Safari + installed PWA).
- [ ] Desktop Chrome (Peter/office daily driver) + one of Edge/Firefox.
- [ ] Crew Android (Chrome + installed PWA) — Jack's or Rob's actual phone at enrolment.
- [ ] Estimator laptop (Luke's actual machine).

---

## Cutover runbook (ordered — do not shuffle)

1. **Pre-flight (T-3 days):** complete S0–S8 + S13 + S14. T&Cs legal review signed off
   (ClickUp 869e35z42) — real customers will be signing these terms. Snapshot the DB.
2. **Team identities:** swap `.test` emails → real (Settings → Team); each person signs in,
   registers passkey + push on their real device (S11/S12 per person).
3. **Routing env:** INBOUND_FORWARD_EMAIL → hello@marleymoves.co.uk, OPS_ALERT_EMAIL → the
   office address; restart; send one inbound-reply test + one ops alert to verify.
4. **Data reset:** run reset-data.mjs to clear ALL test/mock leads, quotes, comms and
   appointments. Verify staff, fleet, settings, templates and any REAL storage records survive.
5. **Backfill:** remove SANITY_SYNC_DISABLED → redeploy → "Sync website leads". THEN IMMEDIATELY
   run the chase-safety step below before the next chase cron tick.
6. **⚠ Chase-safety gate (the biggest cutover risk):** backfilled historical leads arrive as
   open enquiries — the chase engine and 30-day auto-lapse will act on them. Before the next
   cron tick: bulk-set genuinely dead historical leads to completed/lost, and spot-verify the
   chase queue is EMPTY of anything you don't want emailed. A backfill that triggers 50 chase
   emails to old enquirers is the worst possible day-one event.
7. **Card payments:** when Connor's merchant creds land — S9 in full, then leave the switch ON.
8. **Go live:** Connor + team start entering real enquiries. iMVE runs in PARALLEL for 2 weeks
   (double-entry of bookings only) — hard-cut iMVE only after the first real job completes
   end-to-end in Marley Ops (quote → deposit → job sheet → sign-off → balance).
9. **Day-1/Day-2 watch:** run S0 each morning; check Automations page for red crons; check
   /payments reconciles to Zoho each evening; review events_log for surprises.
10. **Week-1 review:** loss reasons + chase replies sanity check, storage invoices correct,
    first review request actually sent, backup restore drill repeated on real data.

## Sign-off criteria

| Gate | Requirement |
|---|---|
| Money | S3, S4, S6, S8 billing, S9 all green — every £ path double-entry verified in Zoho |
| Evidence | Contract, completion and storage signatures each produced + retrievable from /documents |
| Access | S1 + S13 green — no role sees or actions what it shouldn't |
| Comms | S5 green — no template broken, chase timing verified, duplicate guard holds |
| Ops | S14 green — restore drill done, crons green, uptime alerting live |
| People | Each real user signed in on their real device with push working (S11/S12/S15) |

Any red in the Money or Access rows = no cutover. Everything else can go live behind a
known-issues list.

