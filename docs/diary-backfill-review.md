# Diary backfill — review sheet (Peter + Luke, Monday 2026-08-10)

**Status: PARKED, awaiting row-by-row confirmation. Nothing has been written.**

## What this is

Nine confirmed, deposit-paid jobs have no entry in the diary. Until 2026-08-07
nothing created the removal appointment automatically — someone had to add each
booking by hand — and these nine were confirmed before that fix shipped. Every
booking from now on gets its diary entry the moment the deposit lands, so this
is a one-off catch-up, not a recurring chore.

**What depends on the diary entry:** `/schedule` capacity (so quoting a new job
warns you the day is taken), crew day sheets the evening before, job sheets and
completion sign-off, and the whole post-move chain — auto-complete, review
request, and the balance-overdue alarm. All of that is currently dark for these
nine.

**What the backfill does NOT do:** no customer emails, no crew notifications for
past jobs, no changes to money, quotes or leads. It writes nine diary rows, each
cancellable or deletable from `/schedule`.

## Rows to confirm

Snapshot taken 2026-08-08. **Re-run the dry run on the day** — it derives live,
so anything Connor books by hand before Monday drops out automatically.

| ✓ | Customer | Quote | Move date | Van | Job value | Outstanding | Notes |
|---|---|---|---|---|---|---|---|
| ☐ | Rebecca Eldred | MMR017 | 5 Aug **(past)** | 1 luton | £500.00 | £400.00 | Moved 3 days ago. Adding it raises the internal money alert for the £400 — no customer email. |
| ☐ | Vanessa Taylor | MMR041 | 7 Aug **(past)** | 1 luton | £360.00 | £260.00 | Moved yesterday. Same — internal alert only. |
| ☐ | Brydee Thomas | MMR034 | 12 Aug | 1 luton | £600.00 | £450.00 | Her "move date confirmed" email never reached her (see below). |
| ☐ | Priscilla Kong | MMR020 | 17 Aug | 3 luton | £2,695.20 | £2,595.20 | Largest outstanding balance. |
| ☐ | Greig James | MMR015 | 21 Aug | transit | £840.00 | £740.00 | |
| ☐ | Marks Davis | MMR019 | 25 Aug | 2 luton | £1,856.40 | £1,756.40 | His "one last step" email failed on 3 Aug, outcome unknown. |
| ☐ | Kristina Butts | MMR042 | 27 Aug | 2 luton | £1,250.00 | £1,150.00 | **DATES DISAGREE** — enquiry said 14 Aug, quote says 27 Aug. Confirm which before the diary treats 27 Aug as settled. |
| ☐ | Corinna Booth | MMR037 | 1 Sep | 1 luton | £900.00 | £800.00 | |
| ☐ | Mat Broadway | MMR033 | 1 Oct | 3 luton | £2,449.44 | £2,349.44 | Only one with a completed survey on file. |

**Totals: 9 jobs · £11,451.04 of work · £10,501.04 still to collect.**

Every row is a full day, 08:00–17:00 UK, titled `Removal — <customer>`, located
at the pickup address on the lead.

## Worth deciding while you have Luke

1. **Kristina Butts' date** — 14 Aug or 27 Aug. The only row where the two
   recorded dates disagree.
2. **The two past jobs** — include them (recommended: it turns on the money
   alert for £660 that has been invisible) or leave them out and chase the
   balances manually.
3. **Crew day sheets** — from 12 Aug onward these jobs start generating day
   sheets the evening before. Confirm the crew contact details in Staff & Fleet
   are right, or the first sheets go nowhere.

## To run it on Monday

From `o:\projects\red-banana\clients\marley\marley-ops`:

```
# 1. Re-derive live — confirms the list still matches this sheet
node scripts/backfill-removal-appointments.mjs --prod

# 2. Then either
node scripts/backfill-removal-appointments.mjs --prod --include-past --commit   # all nine
node scripts/backfill-removal-appointments.mjs --prod --future-only --commit    # skip the two past
```

Needs prod credentials (the runbook pattern in `docs/ovh-deployment.md`), and the
auto-mode classifier will ask for approval on the `--commit` run.

**To undo:** cancel or delete the appointments from `/schedule`. They carry the
note "Backfilled — booking confirmed before the diary auto-book shipped".

## Not part of this, but adjacent

- **Brydee Thomas MMR034** — her move-date confirmation and invoice never
  reached her (a template variable exceeded Resend's length cap on 5 Aug).
  Peter's call 2026-08-08: **do not re-send**, likely already communicated
  another way. The underlying bug is fixed both ways now — new sends can't hit
  the cap, and a permanently-rejected message escalates on the first failure
  instead of being re-driven eight times.
- **Marks Davis MMR019** — his 3 Aug email failed with the outcome recorded as
  genuinely unknown, so we cannot say whether he received it.
