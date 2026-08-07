# HANDOFF — audit remediation batch (2026-08-07)

Goal: fix the findings from the five-agent audit + live prod sweep. Source of truth for
the findings is ClickUp (marley Now: 869efjdnj, 869efjdnk, 869efjdnp, 869efjdnr;
Next: 869efjdnv, 869efjdnx, 869efjdnz, 869efjdp0, 869efjdp2).

Standing rules: test on STAGING never prod · migrations staging-first · all four gates
(lint · tsc · vitest · build) before any push · push by default staging then master.

## Milestones

All code changes are committed on `staging` as **27e0082** (gates: lint 0 · tsc 0 ·
vitest 1385 · build ✓).

1. **Diary gap** — DONE. `lib/schedule/ensure-removal-appointment.ts`, hooked into
   `markDepositPaid` + `confirmMoveDate`.
   Verified: 6 unit tests (creates once at 08:00–17:00 UK, idempotent, skips imve,
   refuses to invent a date, returns error instead of throwing, no-lead no-op).
2. **Post-move balance alarm** — DONE (guard scoped to `source='post_move_overdue'`,
   window ordered + 60-day floor, stale pre-move card superseded).
   Verify: STAGING e2e scenario, script at
   `scratchpad/staging-balance-alarm-test.mjs` (setup → trigger cron → verify → cleanup).
   NOT YET RUN — waiting on CI to finish so the reseed doesn't wipe the scenario.
3. **Unsigned-contract surfaces** — DONE (dashboard tile + /documents exclude imve
   and cancelled). Verified by build + review; no dedicated test.
4. **Resend 2000-char cap** — ALREADY FIXED earlier today in the SMTP-fallback work
   (`dispatch.ts:176` falls back to in-repo HTML). No new change needed.
   RESIDUAL: Brydee Thomas MMR034's stored payload is still poisoned — her
   "Move date confirmed" email + invoice has never been delivered and needs a
   MANUAL re-send. Customer-facing, so not automated.
5. **Chase engine hardening** — DONE (both driving queries error-check + throw;
   duplicate == delivered; step stamps checked; post-move query error counted).
6. **Follow-up close set** — DONE (inbound_reply + no_answer join quote_followup;
   money tasks deliberately excluded).
7. **UI truth batch** — DONE (preferred_date → booked date, 25% chip gated on an
   actual commitment invoice, /schedule uses the current accepted quote and skips
   cancelled, /bookings dates in UK time, cancelled bookings dropped from won
   revenue on /performance + /quotes).
8. **Ship** — staging pushed (CI running). Promote to master after CI + the
   milestone-2 staging verification.
9. **Backfill script** — WRITTEN: `scripts/backfill-removal-appointments.mjs`
   (dry-run default, `--future-only` / `--include-past`, prod-guarded). NOT RUN.
   DANGER: backfilling PAST-dated appointments on prod triggers the post-move sweep
   (auto-complete + review-request emails to real customers) and the crew-sheet cron.
   Staging only until Peter explicitly approves prod.

## Live-data state (read-only sweeps, 2026-08-07)

- Cross-table contradiction sweep across 8 classes: **zero findings** (32 leads,
  27 quotes, 5 appointments, 32 clients). The data is coherent.
- Money-layer traps from the audit are all **latent, not live**.
- Still outstanding operationally: 9 confirmed jobs missing diary rows (milestone 9),
  £2,810 unmatched bank money, Brydee's undelivered email, the card-gateway
  response-code-6 cluster to raise with takepayments.

## Notes / decisions

- Backfill is deliberately NOT auto-run on prod — customer-facing email side effects.
- Milestone 1 hook point: `markDepositPaid` (the moment the lead becomes `confirmed`),
  fail-soft so a diary failure can never break payment recording.
