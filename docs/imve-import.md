# iMVE → marley-ops import runbook

Brings the ~20 live iMVE bookings into the panel so there is ONE diary. Legacy
jobs were sold under iMVE-era terms, so the panel treats them as hands-off for
money automation:

- `quotes.source = 'imve'` HARD-excludes them from the commitment ladder
  (T-10 chase, T-7 "date at risk"), from `ensureCommitmentInvoice` (no Zoho
  commitment invoice can ever be raised), from the online date-confirm flow,
  and from contract-signature nags (schedule chips + crew sheets).
- Leads land as `confirmed` + `chase_paused = true` — the quote/deposit chase
  engine never sees them.
- **No emails fire on import.** Nothing is sent to these customers unless a
  human triggers it.
- Payments are matched **manually** (Payments → Attach to quote, or the
  mark-paid buttons). iMVE references sometimes duplicate, so nothing
  auto-matches on them. Deposits/balances already received go in the CSV so
  the imported money state is true on day one.
- Connor's existing Zoho DRAFT invoices link by reference only
  (`imve_zoho_invoice_number`, shown on the booking) — the panel never adopts
  them into its own invoice machinery, and "raise balance invoice" stays a
  manual decision (check the draft first so the customer isn't invoiced twice).

What still applies to legacy jobs (deliberately): they appear on /schedule
with crew/van capacity (from the `vehicle` column), post-move unpaid-balance
alerts are internal-only (follow-up task + ops alert, no customer email), and
a fully-paid job auto-completes after move day (which sends the standard
review request — they are real completed Marley jobs).

## 1. Fill the CSV

Template: `docs/imve-import-template.csv` (delete the two example rows).
Required: `imve_ref`, `customer_name`, `moving_date`, `agreed_price`.
Strongly recommended: `email` and/or `phone` (dedupes against existing
clients), `deposit_*` (money truth), `vehicle` (schedule capacity:
transit/1luton/2luton/3luton/4luton/5luton).

Dates accept `YYYY-MM-DD` or `DD/MM/YYYY`. `deposit_paid`/`balance_paid` are
y/n. Duplicate `imve_ref`s are tolerated (the panel ref gets a `-2` suffix,
the raw ref is kept) but the dry run flags them — check each is a distinct job.

## 2. Staging first — always

```bash
# from marley-ops/ on i9, CSV alongside:
node --env-file=.env.staging scripts/import-imve.mjs jobs.csv            # dry run (default)
node --env-file=.env.staging scripts/import-imve.mjs jobs.csv --commit   # write
```

(`.env.staging` needs the staging project's `NEXT_PUBLIC_SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` — same values as `/opt/marley-ops-staging/app.env`.)

Review on staging.ops.marleymoves.co.uk: Bookings shows the jobs with the
"Legacy (iMVE)" chip, /schedule shows each move day, Payments shows the
expected balances. Then roll it back so staging stays clean, or leave it as
test data:

```bash
node --env-file=.env.staging scripts/import-imve.mjs --rollback imve-YYYY-MM-DD --commit
```

## 3. Prod

Migration 0088 must already be applied (staging AND prod — see
`ovh-deployment.md`). Then on the VPS (docker one-off pattern; direct shell
writes are blocked):

```bash
scp -i ~/.ssh/rbs_vps scripts/import-imve.mjs jobs.csv ubuntu@51.195.253.165:/tmp/
ssh -i ~/.ssh/rbs_vps ubuntu@51.195.253.165 \
  "cd /tmp && sudo docker run --rm --env-file /opt/marley-ops/app.env \
     -v /tmp/import-imve.mjs:/work/import-imve.mjs -v /tmp/jobs.csv:/work/jobs.csv -w /work \
     node:22-alpine sh -c 'npm i @supabase/supabase-js --no-save --silent && node import-imve.mjs jobs.csv --prod'"
# review the dry-run plan, then re-run with:  ... node import-imve.mjs jobs.csv --commit --prod
```

Note: the `--prod` gate assumes "hosted `*.supabase.co` = staging, anything
else = prod". If prod ever moves to hosted Supabase, update the check in
`scripts/import-imve.mjs` before trusting the gate.

## 4. Undo

`--rollback <batch>` (batch = `imve-YYYY-MM-DD`, printed at import time; dry
run by default, `--commit` to delete). It refuses if real records have since
attached — matched bank transactions, signatures, or communications on the
batch — so evidence of money or customer contact can never be deleted.

## 5. After import (manual, as payments arrive)

- Bank transfers for legacy jobs: Payments → the transaction → **Attach to
  quote** (exact amount enforced), or mark deposit/balance paid from the
  booking with the real method.
- Rescheduling via the booking drawer is safe — the date-change email only
  cites commitment terms when a commitment invoice exists (legacy never has
  one).
- iMVE itself becomes read-only reference after cutover.
