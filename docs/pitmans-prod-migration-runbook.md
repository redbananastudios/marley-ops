# Pitmans multi-brand — production migration runbook

**Who runs this: Peter, over SSH, on promotion day** — which is work-bound rather than dated (multi-brand PRD §5, §11.6): validated gates plus Peter's word, on a clear working day outside the 21–28 September import week. The build agent applies these files to STAGING only; production is human-only. Files apply **in order**, in one sitting. There are **two** `notify pgrst` steps in that order — one before the deploy and one after the last file — because the deploy sits in the middle of the batch and the code it starts reads columns applied either side of it. Some files carry their own as well; running it twice is harmless.

Every gate that adds a migration appends its row here in the same commit. The runbook stays current from gate 1 so promotion day is a scripted operation, not an act of memory.

**Before starting:**
- Pick a quiet window — no one issuing quotes or accepting bookings (0104's counter seed reads the live sequences; see its RACE comment).
- Confirm prod == the promoted `master` tip and the staging e2e suite passed on that exact tree.

**Connection** (per `docs/ovh-deployment.md`): SSH to the OVH box, `psql` into the `supabase-db` container. Direct prod writes are classifier-gated for agents — this file exists so a human runs them.

---

## Migration order

| # | File | What it does | Quiet-window sensitive |
|---|---|---|---|
| 1 | `supabase/migrations/0104_brands.sql` | brands table + seed (pitmans `active=false`), brand columns on leads/quotes/appointments/storage_sites/storage_lets/vehicles, `brand_ref_counters`, `next_quote_ref(kind, brand default 'marley')` (drops the one-arg) | **YES** — counter seed races live quote acceptance; also DROPs the RPC signature PostgREST has cached |
| 2 | `supabase/migrations/0105_additional_charges.sql` | `quotes.additional_charges numeric(10,2) not null default 0` + `quotes.additional_charges_reason text` — internal uplift (PRD §3.9), folded inside the customer's "Your Removal" line; default 0 backfills every existing quote as "no uplift" | No — additive columns with defaults; existing rows and totals untouched |
| 3 | `supabase/migrations/0106_ingest_brand.sql` | replaces 0102's global unique index on `leads.external_lead_id` with `leads_external_lead_brand_uq` on `(brand, external_lead_id)` — two brands' websites can mint the same submission id without the second being silently swallowed as a duplicate of the first | No — index swap on a small table; creates the new index before dropping the old, so uniqueness never lapses |
| 4 | `supabase/migrations/0107_pitmans_sms_sender.sql` | sets `brands.sms_sender = 'Pitmans'` on the pitmans row — the WebEx alphanumeric sender id, created 2026-08-26, that 0104 had to seed NULL. Until it lands every Pitmans SMS (including the deposit/balance money chases, whose bodies already say "Pitmans Removals & Storage here") is delivered fronted by MARLEY'S sender id, and replies land on Marley's rail | No — one-row data UPDATE, slug-scoped; Marley cannot be affected (smsSenderFor ignores the column for the default brand). No `notify pgrst` needed: no schema change |
| 5 | `supabase/migrations/0108_ledger.sql` | creates `ledger_tokens` (the persistent OAuth token row the Xero adapter needs, because Xero rotates its refresh token on every use and env-var storage therefore locks the integration out the moment a second container refreshes) and `ledger_invoice_archive` (the pre-cutover snapshot of the outgoing provider's books, so /finance keeps its view of hand-raised invoices after the Zoho account lapses). Both tables land EMPTY and nothing reads them while `LEDGER_PROVIDER` is unset or `zoho` | No — two new tables, no existing table touched, no data written. Carries its own `notify pgrst` |

*(rows appended per gate)*
| 6 | `supabase/migrations/0109_ledger_provider_stamp.sql` | six nullable `*_provider` columns (four on `quotes`, one on `storage_invoices`, one on `card_payments`) recording WHICH ledger minted each stored document id, backfilled to `zoho` — prod has never run anything else. Without them the Zoho→Xero flip reads every stored Zoho id against Xero: the not-found looks transient, a customer who HAS paid is never marked paid, and the poller keeps reporting healthy runs while the chase emails go out | No — additive nullable columns plus a one-off backfill UPDATE; nothing reads them until the deploy |
| 7 | `supabase/migrations/0111_payment_policy.sql` | `clients.payment_terms_days integer not null default 30` (check 30/60) and `quotes.payment_policy text` (check residential/commercial), plus a backfill stamping every ALREADY-ACCEPTED quote `residential` — which is the ladder they already ran. Lays the rails for the commercial path (gate 10); changes no behaviour on its own | **Ordering matters — see below.** Otherwise no: additive columns, and the backfill only writes rows that are already accepted |
| 8 | `supabase/migrations/0112_small_job_threshold.sql` | `business_settings.small_job_threshold numeric(10,2) not null default 300` (check >= 0) — the gross at or under which acceptance asks for the WHOLE job in one payment, killing the £100-then-£20-tomorrow shape. 0 disables the rule | **Same ordering rule as 0111 — before the deploy.** `requestedDeposit()` takes the threshold as a REQUIRED argument read from settings, so once the code is live every ask on every surface reads this column |
| 9 | `supabase/migrations/0113_commercial_path.sql` | `quotes.commercial_due_date date` + `quotes.po_number text` (length-checked) — the completion invoice's terms date and the optional client PO. Inert for every existing row: both are read only when `payment_policy = 'commercial'`, and 0111 backfilled every accepted quote to `'residential'` | **Same ordering rule as 0111/0112 — before the deploy.** The deployed code names both columns in explicit select lists (`QUOTE_COLS` in `lib/quote/accept-flow.ts`, and `loadBookingRows`), so if it is missing, acceptance fails and every money surface silently renders empty — see below |
| 10 | `supabase/migrations/0114_pitmans_import.sql` | `quotes.legacy_ref`, `import_batch` on the five tables the importers write, four partial indexes, and the `quotes_source_check` **widened** (never narrowed) to accept `'pitmans'` | No — additive and inert; nothing reads these columns until the importers run in the 21–28 September window. Placed before the deploy for one reason only: it keeps the whole batch in one pre-deploy block, so there is no second `psql` session to remember after the restart |
| 11 | `supabase/migrations/0115_crate_calendar_month_minimum.sql` | `storage_lets.min_kind text not null default 'days'` (check `days`/`calendar_month`) — freezes HOW a crate let's minimum window is measured, per the 0075 pattern; plus a triple-guarded backfill flipping only crate lets with no arrears grid in motion, no v1 (28-day) signature, and no `import_batch` to `calendar_month` (storage-terms v2, 2026-08-31) | **Same ordering rule as 0111–0113 — before the deploy.** The deployed code names `min_kind` in explicit storage-billing select lists; missing, crate billing fails on every run. Every existing row defaults to `'days'` = bit-identical billing |
| 12 | `supabase/migrations/0116_crate_minimum_pre_v2_signatures.sql` | takes back the crate lets 0115 flipped whose storage signature predates the calendar-month terms. 0115 recognised a v1 signature by `terms_version like 'storage-terms-v1%'`, which is false or NULL for every signature taken before the first published storage terms — so the cohort its guard names as "keeps exactly the schedule they signed" is the cohort it flipped. Reverts only lets already on `calendar_month` whose storage signature is not demonstrably v2-or-later; a let with no storage signature is left alone, as 0115 intended | No — one UPDATE, narrower than 0115's, and a no-op when the class is empty. Must run immediately after 0115 |
| 13 | `supabase/migrations/0117_customer_survey_photos.sql` | `survey_photos.customer_uploaded boolean not null default false` (+ a partial index), `surveys.customer_photos_noted_at timestamptz`, and two `security definer` functions: `add_customer_survey_photo(uuid, text, integer)` — the count-guarded, `for update`-serialised insert that enforces the per-survey ceiling on customer /cv photos in the database rather than in the route, and reports "has the office been told yet?" from the new stamp rather than from a live count — and `ensure_customer_survey_row(uuid, uuid)`, the per-lead advisory-locked find-or-create for the `surveys` row those photos hang off. No backfill by design: every existing photo row stays `false` = "an office photo", and every existing survey's stamp stays null = "no customer photo has ever arrived", which is exactly today's behaviour on every reader | **Same ordering rule as 0111–0116 — before the deploy.** The deployed crew photo readers name `customer_uploaded` in an `eq` filter, so a missing column means PostgREST rejects the select. The readers now throw and log rather than swallowing it, but `crew-sheet/dispatch.ts` and `/my-jobs/[id]` deliberately absorb that so the crew still get their sheet and their job — so a deploy-before-migrate ships crews to customers with the access shots missing, not an obvious outage. The /cv upload route calls BOTH functions, so either one missing 503s every customer photo. Carries its own `notify pgrst` |
| 14 | **RELOAD THE SCHEMA CACHE** — `notify pgrst, 'reload schema';` | not a migration. 0109, 0113, 0114 and 0115 carry no reload of their own, so without this the container started on the next row queries a PostgREST whose cached schema has never seen `commercial_due_date`, `po_number`, `legacy_ref`, `import_batch` or `min_kind` — and PostgREST rejects a select naming a column it does not know about, which is exactly the empty-and-healthy failure described under 0113 below | — |
| 15 | **DEPLOY THE CODE** | not a migration — the promotion's container restart. It must happen HERE: after 0111 and 0113 (which the new code writes to and selects on every acceptance) and before 0110 (whose constraints the new code is what satisfies) | — |
| 16 | `supabase/migrations/0110_ledger_provider_checks.sql` | the CHECK constraints that make the stamp mandatory: a write that sets an id without its provider FAILS instead of silently claiming the wrong system | **YES, and in the opposite direction to everything above** — see the note below |

### 0111, 0112, 0113, 0115, 0116 and 0117 must run BEFORE the deploy — and therefore before 0110

This is the mirror image of 0110's rule, so read both before running either.

From the moment the new code is live, BOTH accept paths write `payment_policy` in the
same UPDATE that marks a quote accepted. If the column does not exist yet, PostgREST
rejects that UPDATE — so the customer's own acceptance at `/q` and the office accepting
on their behalf BOTH fail, and the customer is told to phone in. Acceptance is the
single most expensive thing in this system to break.

0112 carries the same rule for the same reason: `requestedDeposit()` reads the small-job
threshold as a required argument on every acceptance, quote page and chase email, so the
column has to exist before the code that reads it.

**0113 is the same rule again, and it fails in a quieter way, so it is the one to get
right.** Its two columns are named in explicit select lists, not written conditionally:
`QUOTE_COLS` in `lib/quote/accept-flow.ts` ends in `po_number` and backs every
`fetchQuoteByToken` / `fetchQuoteById`, and `loadBookingRows` selects
`commercial_due_date`. A missing column makes PostgREST reject the whole SELECT, so
every customer's `/q` page renders as the friendly not-found card and every acceptance
fails — and because `loadBookingRows` reads through `fetchAllRows`, which fail-softs by
design, `/bookings`, both `/payments` tabs and the dashboard money tiles come back
**empty and healthy-looking** rather than erroring. Every live booking and every pound
outstanding would be invisible with nothing on screen saying a read had failed. That is
the shape this codebase has been bitten by repeatedly: the surface that would have shown
the problem is the one the failure just cleared.

That is why 0111, 0112 and 0113 sit above the deploy row and 0110 sits below it, which
means they apply BEFORE 0110 despite the higher numbers. They are independent (unrelated
tables and columns), so the out-of-order run is safe — but it is deliberate, not a typo.
Apply in the order the table gives, not in filename order.

0114 has no such constraint — nothing in the deployed code reads its columns until the
importers run in the import week — but it is listed in the batch anyway so the whole
migration set is one pre-deploy block with no second session to remember.

0116 inherits 0115's position for a different reason: it corrects rows 0115 has just
written, so the two belong in the same breath. Leaving it for later would mean crate
billing runs, and the /s page renders, against a minimum the customer did not sign.

0117 sits above the deploy row for the 0113 reason in its purest form. The deployed
crew photo readers (`loadPhotoDataUris`, `loadPhotoSignedUrls`) add
`.eq("customer_uploaded", false)`, so against a database that has not run 0117
PostgREST rejects the select outright.

Both readers now inspect `error` and THROW (`assertPhotoRead`), rather than the
earlier destructure that dropped it — so the failure is logged rather than silent.
Do not read that as "safe to deploy first", because the throw is deliberately
absorbed at two of the four call sites: `lib/crew-sheet/dispatch.ts` still sends the
day sheet without photos (it now also records a `photos` entry in `summary.failures`,
so the run no longer reports clean) and `app/my-jobs/[id]` still renders the job
without its photo strip. Both are the right call for a crew member who needs the
address at the door — but they mean a deploy-before-migrate still puts crews in front
of customers with the access and parking shots missing, and now with a burst of
errors in the log. `app/sheet/[token]` degrades the same way. The upload half fails
outright (either of `add_customer_survey_photo` and `ensure_customer_survey_row`
missing → every `/cv` photo 503s).

**So the ordering is unchanged and still mandatory: 0117 before the deploy.** It
carries its own `notify pgrst`; the reload row below is still correct for the batch
members that do not.

**And the reload row exists for the same reason 0113 does.** Applying a column is not
the same as PostgREST knowing about it: the cache reloads on `notify pgrst`, and 0109,
0113, 0114 and 0115 are the batch members that carry none of their own. Restarting the
container against a cache that predates them puts the new code's explicit select lists
in front of columns PostgREST will refuse — the empty-and-healthy shape above, only
this time with nothing wrong in the database at all. It costs one statement; run it.

### Changes the DEPLOY carries with no migration of their own

Not everything in this promotion has a row above it, and the table is the thing a
reader trusts. Gate 9b (late bookings raise the balance in the same breath, PRD
§3.10 Addition 2) is pure code: it goes live the instant the container restarts and
leaves no trace here. Verify it after the deploy rather than looking for a file:

- A quote accepted **at `/q`** whose move is inside 7 days now raises its `-BAL`
  invoice immediately, beside the collapsed 25% ask, instead of waiting for the
  09:00 chase cron (which in turn waits for the deposit to be paid and the date
  confirmed — for a move on Thursday, often too late to be useful). Two invoices are
  open at once and they still sum to exactly the agreed price: the balance always
  carves the deposit out whether or not it has been paid.
- The same booking accepted by the **office** ("Mark won") is unchanged, and that is
  deliberate rather than an oversight — `lib/payments/late-balance.ts` records why the
  customer's own contract signature is a condition of raising early.
- The balance email drops its "your deposit is already accounted for" line whenever
  the deposit is genuinely unpaid, and names the deposit, the balance and the total
  instead. That also applies to the ordinary T-7 raise in the rare case it meets an
  unpaid deposit, where the old line was simply wrong.

Gate 9c (settle in full at the commitment step) is the same shape — code only, live on the
restart. After the deploy, the commitment state at `/q` gains a second amount card and the
date-confirmation email a second figure, for any booking with a raised, unpaid 25% invoice.
Choosing it raises that booking's `-BAL` early; ignoring it changes nothing at all, which is
the property to spot-check rather than the new card.

First live check: the first Marley acceptance after promotion whose move is inside a
week. Confirm exactly two invoices exist against it and that they sum to the agreed
price — not three, and not 125% of the job.

### 0110 is the one migration that must run AFTER the deploy

Every other file here goes on before the deploy, so a new container never queries a
column that does not exist. A CHECK constraint inverts that rule: the code **already
running** does not write the stamp, so applying 0110 first rejects every invoice raise
until the new containers are up — deposit, commitment, balance and storage alike.

This is not theoretical. On staging (2026-08-27) the constraints were applied ahead of
the writers and the e2e seed died on the first deposit invoice it tried to raise, with
a check-constraint error that reads like a bug in the seed rather than a sequencing
mistake. On prod the same window is live customers accepting quotes.

So the order is: **0109 → deploy → 0110 → `notify pgrst`.** If the deploy has to be
rolled back after 0110 is on, drop the six constraints first — the old image cannot
satisfy them.

**Apply this one file with `--single-transaction`.** 0110's header says it is safe to
re-run after a failure. That is true of its six sweeps and false of the three
`alter table … add constraint` statements underneath them: Postgres has no
`ADD CONSTRAINT IF NOT EXISTS`, and the standard recipe in `docs/ovh-deployment.md`
pipes the file into `psql -v ON_ERROR_STOP=1` with no transaction, so each statement
autocommits on its own. A failure at the storage or card-payments ALTER therefore
leaves the four `quotes` constraints committed, and the documented recovery — re-run
the file — fails on `constraint "quotes_deposit_invoice_provider_ck" … already exists`,
which reads like a fresh problem mid-promotion:

```bash
ssh -i ~/.ssh/rbs_vps ubuntu@51.195.253.165 \
  "sudo docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction" \
  < supabase/migrations/0110_ledger_provider_checks.sql
```

Then a failure rolls the whole file back and re-running it really is safe. If it has
already been applied without the flag and stopped part-way, drop whichever constraints
landed (`select conname from pg_constraint where conname like '%_provider_ck';`) before
re-running — do not try to re-run over them.


### The image/migration window cuts BOTH ways — keep it inside the quiet window

There is no deploy order that is safe on its own, so do not treat either half as
the "safe first step":

- **Image first, then migrations** (what "confirm prod == the promoted `master`
  tip" above implies): between the two, `quotes` has no `additional_charges`
  column, so `/quotes/[id]` gets a PostgREST 42703. That page drops the error and
  falls through to `notFound()`, so **every quote in the system renders as a 404**
  — indistinguishable from a deleted quote, with nothing logged.
- **Migrations first, then image**: 0104 DROPs the one-arg `next_quote_ref`, so the
  still-running old image cannot mint a quote reference — **quote creation fails**
  until the new image is up.

Both windows are minutes, and both are survivable only because nobody is issuing
quotes. Do the whole operation — image and all migrations — inside the single
quiet window, and re-check `/quotes/<a real id>` loads before reopening.

---

## After the last file

```sql
notify pgrst, 'reload schema';
```

Self-hosted PostgREST caches the schema — skipping this leaves every new column invisible and, for 0104 specifically, breaks quote creation (the cached one-arg `next_quote_ref` no longer exists).

This is the **second** of the two reloads, and it is not a substitute for the one at row
13: that one is the cache the deploying container reads, this one closes the batch after
0110. Running it twice is harmless; running it only here is not.

---

## Verification — run after `notify pgrst`

### 0104

```sql
-- Three brand rows; pitmans MUST read active = false on prod.
select slug, active, ref_prefix, sort_order from brands order by sort_order;

-- Counters vs the retired sequences: n must be >= the sequence position.
select c.brand, c.kind, c.n,
       (select case when is_called then last_value else 0 end from quote_ref_mmr_seq) as mmr_seq,
       (select case when is_called then last_value else 0 end from quote_ref_mmc_seq) as mmc_seq
from brand_ref_counters c order by c.brand, c.kind;

-- Reconcile the seed race deterministically (no-op when the window was quiet):
update brand_ref_counters set n = greatest(n, (select case when is_called then last_value else 0 end from quote_ref_mmr_seq)) where brand = 'marley' and kind = 'R';
update brand_ref_counters set n = greatest(n, (select case when is_called then last_value else 0 end from quote_ref_mmc_seq)) where brand = 'marley' and kind = 'C';

-- Columns landed:
select count(*) as leads_marley from leads where brand = 'marley';
```

### 0105

```sql
-- Columns landed, every existing quote backfilled to a zero uplift (the
-- migration is inert for live totals — subtotal/grand_total are untouched):
select count(*) as quotes_total,
       count(*) filter (where additional_charges = 0) as quotes_zero_uplift,
       count(*) filter (where additional_charges <> 0) as quotes_with_uplift
from quotes;
-- quotes_with_uplift MUST be 0 immediately after the migration; the first
-- non-zero rows appear only once the office starts using the builder field.
```

Then, from the app (not psql): create one draft quote on a test lead and confirm it receives the next `MMR###` in sequence — that proves PostgREST resolved the new function signature. Do NOT call `next_quote_ref` from psql to "test" it: every call mints a real reference.

### 0106

```sql
-- Exactly one index over external_lead_id remains, and it keys on BOTH columns.
select indexname, indexdef
from pg_indexes
where tablename = 'leads'
  and indexname in ('leads_external_lead_uq', 'leads_external_lead_brand_uq');
```

Expected: one row, `leads_external_lead_brand_uq`, whose `indexdef` reads `(brand, external_lead_id)` and carries `WHERE (external_lead_id IS NOT NULL)`. If `leads_external_lead_uq` still appears, 0106 did not complete — re-run it before taking Pitmans website traffic.

Cross-brand duplicate-id check — **described, not executed** (prod leads are real customers; do not insert test rows): the property this index guarantees is that two leads may share an `external_lead_id` when their `brand` differs, and never when it matches. It is proven by the unit suite that runs against every promoted build (`tests/lib/leads/website-lead.test.ts` — same id under two brands lands two leads; same id under one brand adopts the existing row). On prod, the index definition above IS the guarantee — no insert test adds evidence it doesn't already give.

### 0107

```sql
-- The Pitmans WebEx sender id landed, and ONLY on the pitmans row.
select slug, coalesce(sms_sender, '<null>') as sms_sender from brands order by slug;
```

Expected exactly: `pitmans` = `Pitmans`; `marley` and `group` both `<null>`. Marley's
sender is NOT read from this column at all — `smsSenderFor()` short-circuits the default
brand to the `WEBEX_SMS_SENDER_MARLEY_MOVES` env chain — so a null there is correct, not
a missing value to go and fill in.

No app-side check is needed beyond this: the code path is already locked by
`tests/lib/comms/send-idempotency.test.ts`, which asserts both that
`smsSenderFor({slug:"pitmans", smsSender:"Pitmans"})` returns `Pitmans` and that the
WebEx request body carries `from: "Pitmans"` while an unbranded send still carries
`from: "Marley"`. What was missing was only the data.

### 0108

```sql
-- Both tables exist, are EMPTY, and are locked to the service role: RLS on with
-- ZERO policies is the whole access control here. ledger_tokens holds live OAuth
-- credentials for the real books, so a policy count of anything but 0 is a stop.
select c.relname                                        as tbl,
       c.relrowsecurity                                 as rls_enabled,
       (select count(*) from pg_policies p where p.tablename = c.relname) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('ledger_tokens', 'ledger_invoice_archive')
order by 1;

select (select count(*) from ledger_tokens)           as tokens_rows,
       (select count(*) from ledger_invoice_archive)  as archive_rows;
```

Expected: two rows, both `rls_enabled = true` and `policies = 0`; and both counts
**0**. A non-zero `tokens_rows` on prod would mean someone has already authorised a
provider against production — check with Peter before going further.

No app-side check is needed: gate 17's contract is zero behaviour change, and
`LEDGER_PROVIDER` is deliberately left unset at this promotion, so every money path
resolves to the same Zoho adapter it used before. The switch to Xero is a separate,
later env edit — and per `docs/ledger-adapter-design.md` §9 it sets
`LEDGER_HISTORY_CUTOVER` and `LEDGER_PROVIDER=xero` in **one** edit and one restart.
Setting the provider first empties all invoice history with no error; setting the
cutover first puts an unverified archive on the money read path while Zoho is still
authoritative. Neither is recoverable by re-running the snapshot once a human has
read a wrong number off the page.

### 0109 + 0110

Two questions, and they are different: did every existing document get a stamp, and
will a future write without one be refused?

```sql
-- 1. Backfill completeness. Every stored id must carry a provider. A non-zero
--    number here means the flip would read that document in the wrong system.
select
  (select count(*) from quotes           where zoho_deposit_invoice_id    is not null
                                           and zoho_deposit_invoice_id    <> 'pending'
                                           and deposit_invoice_provider    is null) as unstamped_deposit,
  (select count(*) from quotes           where zoho_commitment_invoice_id is not null
                                           and zoho_commitment_invoice_id <> 'pending'
                                           and commitment_invoice_provider is null) as unstamped_commitment,
  (select count(*) from quotes           where zoho_balance_invoice_id    is not null
                                           and zoho_balance_invoice_id    <> 'pending'
                                           and balance_invoice_provider    is null) as unstamped_balance,
  (select count(*) from quotes           where zoho_contact_id            is not null
                                           and zoho_contact_id            <> 'pending'
                                           and contact_provider            is null) as unstamped_contact,
  (select count(*) from storage_invoices where zoho_invoice_id            is not null
                                           and invoice_provider           is null) as unstamped_storage,
  (select count(*) from card_payments    where zoho_credit_note_id        is not null
                                           and credit_note_provider       is null) as unstamped_credit_note;

-- 2. The constraints are actually on (run AFTER 0110).
select count(*) as provider_checks from pg_constraint where conname like '%_provider_ck';
```

Expected: **every count in the first query 0**, and `provider_checks = 6`.

A committed `alter table` is not evidence that a constraint rejects anything, so prove
it does — this rolls back either way, and the message tells you which branch ran:

```sql
begin;
  update quotes
     set zoho_deposit_invoice_id = 'runbook-probe', deposit_invoice_provider = null
   where id = (select id from quotes limit 1);
rollback;
```

Expected: **the UPDATE fails** with `violates check constraint
"quotes_deposit_invoice_provider_ck"`. If it succeeds, 0110 did not apply — stop, because
the stamp is then advisory and the flip is unsafe. (`rollback` is there so the probe
leaves nothing behind even in that case.)

App-side, after the deploy: accept a real quote and confirm the new row has both
`zoho_deposit_invoice_id` and `deposit_invoice_provider = 'zoho'`. A stamp that only
exists on backfilled rows is the failure this whole pair is meant to prevent.

---

### 0111

```sql
select
  (select count(*) from clients where payment_terms_days = 30)                              as on_default_terms,
  (select count(*) from clients where payment_terms_days not in (30, 60))                   as bad_terms,
  (select count(*) from quotes  where accepted_at is not null and payment_policy is null)    as accepted_without_policy,
  (select count(*) from quotes  where accepted_at is null     and payment_policy is not null) as unaccepted_with_policy;
```

Expected: `on_default_terms` = every client, `bad_terms` 0, **`accepted_without_policy` 0**
(the backfill covered the lot) and `unaccepted_with_policy` 0 (it did not over-reach — an
unaccepted quote must take its policy from the client at acceptance, not from a backfill
written today).

Then prove both constraints actually reject, because a committed `alter table` is not
evidence that anything is enforced. Each rolls back either way:

```sql
begin;
  update clients set payment_terms_days = 45 where id = (select id from clients limit 1);
rollback;

begin;
  update quotes set payment_policy = 'business' where id = (select id from quotes limit 1);
rollback;
```

Expected: both UPDATEs fail — `clients_payment_terms_days_valid` and
`quotes_payment_policy_valid`. Both were mutation-tested on staging this way before the
gate merged.

App-side, after the deploy: accept one real quote and confirm the row comes back with
`payment_policy = 'residential'`. Every live client is residential (prod `is_company`
count was 0 at gate 8), so anything else means the resolver is reading the wrong thing —
and a policy that only exists on backfilled rows is the failure this verification exists
to catch.

---

### 0112

```sql
select small_job_threshold, default_deposit from business_settings;
```

Expected: `300.00` and `100.00`. Then prove the constraint rejects (it rolls back either way):

```sql
begin;
  update business_settings set small_job_threshold = -1;
rollback;
```

Expected: fails on `business_settings_small_job_threshold_valid`. Mutation-tested on
staging this way before the gate merged.

App-side, after the deploy: open a quote under £300 and confirm `/quotes/[id]` and the
customer's `/q` page quote the SAME figure — the whole job, not the £100 deposit. Those
two surfaces computing different numbers is the failure mode this gate is most exposed
to, because `/q` is what the customer reads and `/quotes` is what the office reads.

---

## `0113_commercial_path.sql` — gate 10, the commercial completion invoice

Two nullable columns on `quotes` plus a partial index. **Inert for every existing
row**: both are read only when `payment_policy = 'commercial'`, and `0111`
backfilled every accepted quote to `'residential'`. No residential booking
changes behaviour, and the prod pre-flight recorded on `0111` found zero clients
carrying `is_company`, so there are no commercial rows to affect either.

Applied and verified on staging 2026-08-28 before the gate merged.

```sql
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'quotes'
  and column_name in ('commercial_due_date', 'po_number')
order by column_name;
```

Expected: `commercial_due_date` / `date` / `YES`, and `po_number` / `text` / `YES`.

Then prove the length constraint bites (it rolls back either way):

```sql
begin;
  update quotes set po_number = repeat('x', 65)
  where id = (select id from quotes limit 1);
rollback;
```

Expected: fails on `quotes_po_number_len`.

**Why the completion invoice reuses the BALANCE columns rather than getting its
own:** `-BAL` is the last invoice on a job under either policy, so reusing
`zoho_balance_invoice_*` and `balance_invoice_amount` needs no new suffix and no
new `match_kind` (PRD §10). Only the timing differs: raised at completion rather
than T-7, due on the client's terms rather than before move day. A parallel set
of invoice columns would have doubled every "what is outstanding on this job"
read, and every one of them would have been a place to forget the second set.

> **Corrected 2026-09-01.** This paragraph used to add that the reuse "keeps
> /finance, the bank-feed matcher and the ledger adapter working". Two of those
> three were true. `loadLedgerItems` gated its balance item on
> `deposit_paid_at` — which a commercial quote never has, since it takes no
> deposit — so the completion invoice appeared in neither the open nor the
> settled pool and was invisible to the matcher, to `reconcileSettled` and to
> the office's manual attach flow. A commercial BACS payment would have sat in
> "needs a human" permanently, unattachable by that human. Fixed by
> `balanceRungVisible` in `lib/bank-feed/sync.ts`. Reusing a column shape does
> not by itself make a reader policy-aware — the readers still have to be
> checked one by one, and the check is a test rather than a sentence.

App-side, after the deploy: `/bookings` must look **byte-identical** to before
while no commercial client exists — both new sections hide when empty. Confirm
that before creating one.

---

## `0114_pitmans_import.sql` — gate 20, the Pitmans importers

Additive and inert. Five `add column if not exists` on tables the importers
write, one nullable column on `quotes`, four partial indexes, and one CHECK
**widened** (never narrowed) so `quotes.source` accepts `'pitmans'` alongside
`'marley_ops'` and `'imve'`. Nothing existing reads or writes any of it until
an importer runs, and a widened CHECK cannot reject a row the old one accepted.

Applied and verified on staging 2026-08-29 before the gate merged.

```sql
select 'quotes.legacy_ref' as what, count(*)::text as n
from information_schema.columns
where table_schema = 'public' and table_name = 'quotes' and column_name = 'legacy_ref'
union all
select 'import_batch on 5 tables', count(*)::text
from information_schema.columns
where table_schema = 'public' and column_name = 'import_batch'
  and table_name in ('storage_sites','storage_units','storage_lets','vehicles','staff')
union all
select 'source check allows pitmans', count(*)::text
from pg_constraint
where conname = 'quotes_source_check' and pg_get_constraintdef(oid) like '%pitmans%';
```

Expected: `1`, `5`, `1`.

Then prove the CHECK still refuses an unknown source (it rolls back either way):

```sql
begin;
  update quotes set source = 'not_a_system' where id = (select id from quotes limit 1);
rollback;
```

Expected: fails on `quotes_source_check`. Widening the set must not have turned
it into a column that accepts anything — that check is what keeps
`legacyLocked()` meaningful.

**Why `legacy_ref` rather than reusing `imve_ref`:** `imve_ref` is not a generic
"old reference" column. It drives the "Legacy (iMVE)" pill on `/bookings` and
sits behind the crew-paperwork suppressions, so a Pitmans reference parked there
would label a Pitmans booking as an iMVE one on the surfaces the office reads
every day. The customer-facing reference is `quote_ref`, minted fresh per brand
(`PMR###`/`PMC###`, gate 6); `legacy_ref` exists purely so a row can be
reconciled against Mark's own paperwork.

**Why `import_batch` on five more tables:** `--rollback <batch>` has to find
exactly the rows one importer created. Following `0088`'s rule, a row an
importer **matched** rather than created is never stamped, so a rollback can
never delete a customer, van or staff member that existed beforehand.

App-side, after the deploy: nothing should change at all. No importer runs
automatically, and `source = 'pitmans'` does not exist in prod until one does.

---

## `0115_crate_calendar_month_minimum.sql` + `0116_crate_minimum_pre_v2_signatures.sql` — the crate minimum

The only file in the batch whose backfill moves live billing rows, and the only
dial that decides both what a crate let is charged and what its signing page
says it agreed to. So the question is not "did the column land" but **which
lets moved, and is that the set that should have moved** — a backfill that
matched nothing looks exactly like a correct no-op from here.

Run this AFTER both files. Every count is a claim about money.

```sql
select
  (select count(*) from storage_lets where billing_model = 'crate_daily')                        as crate_lets,
  (select count(*) from storage_lets where billing_model = 'crate_daily'
                                       and min_kind = 'calendar_month')                          as on_calendar_month,
  (select count(*) from storage_lets where billing_model <> 'crate_daily'
                                       and min_kind <> 'days')                                   as non_crate_moved,
  (select count(*) from storage_lets where import_batch is not null
                                       and min_kind <> 'days')                                   as imported_moved,
  -- 0116's cohort: still on the calendar month with a signature that predates
  -- the calendar-month terms. This is the number 0115 alone got wrong.
  (select count(*) from storage_lets l
     where l.min_kind = 'calendar_month'
       and exists (select 1 from signatures s
                    where s.storage_let_id = l.id and s.kind = 'storage'
                      and (s.terms_version is null
                           or s.terms_version !~ '^storage-terms-v([2-9]|[1-9][0-9])-'))) as pre_v2_still_moved;
```

Expected: `non_crate_moved` **0**, `imported_moved` **0** (a legacy let bills on
Mark's paperwork, never on our published terms), and `pre_v2_still_moved` **0** —
that last one is 0116's whole job, and a non-zero answer means 0116 did not run.

`on_calendar_month` has no single right value, so read it rather than tick it: it
must be ≤ `crate_lets`, and every let inside it should be one you would expect a
customer to have signed the calendar-month agreement for. **If `crate_lets` is 0
the migration proved nothing** — say so rather than recording a pass.

Then the class 0115 deliberately declines to touch, which nothing else surfaces:

```sql
-- Signed the calendar-month terms, but the 28-day arrears grid is already in
-- motion, so 0115 left it on 'days' rather than re-anchor a moving cursor.
select l.id, l.start_date, l.min_days,
       (select max(i.period_end) from storage_invoices i where i.let_id = l.id) as billed_through
from storage_lets l
where l.billing_model = 'crate_daily'
  and l.min_kind = 'days'
  and exists (select 1 from storage_invoices i
               where i.let_id = l.id and i.kind in ('arrears', 'final'))
  and exists (select 1 from signatures s
               where s.storage_let_id = l.id and s.kind = 'storage'
                 and s.terms_version ~ '^storage-terms-v([2-9]|[1-9][0-9])-');
```

Expected: **no rows.** Any row here is a manual decision for Peter, not something
to fix in psql — the customer signed a calendar month and is being billed on a
28-day grid, and re-anchoring a live cursor double-bills. Take it out of the
window and deal with it separately.

Finally prove the CHECK bites, since a committed `alter table` is not evidence
that anything is enforced (it rolls back either way):

```sql
begin;
  update storage_lets set min_kind = 'month' where id = (select id from storage_lets limit 1);
rollback;
```

Expected: fails on `storage_lets_min_kind_check`.

App-side, after the deploy: start one crate let on staging-shaped test data and
confirm its `/s` signing page reads "one calendar month minimum", while an
existing let that kept `'days'` still reads its own day count. Those two surfaces
disagreeing with the invoices is the failure this pair exists to prevent.

---

## `0117_customer_survey_photos.sql` — the customer /cv photo discriminator, the atomic ceiling, and the atomic anchor row

Four things land together because each needs one of the others' columns or
locks:

1. `survey_photos.customer_uploaded` — a boolean that says "a customer sent
   this", so the crew's oldest-first photo window is not starved by photos that
   arrived before the survey visit;
2. `surveys.customer_photos_noted_at` — a stamp recording that the lead's
   timeline has been told, so deleting and re-uploading a blurry photo cannot
   write the same line again on every cycle;
3. `add_customer_survey_photo(uuid, text, integer)` — a `security definer`
   function that inserts one customer photo under a per-survey ceiling
   **atomically**, and reports whether the office has yet been told;
4. `ensure_customer_survey_row(uuid, uuid)` — the per-lead advisory-locked
   find-or-create for the `surveys` row those photos hang off. Without it two
   concurrent first uploads created two rows, and since every reader on both
   sides takes only the lead's NEWEST survey, whichever photo landed on the
   loser was invisible to the customer and the office forever.

First prove the photo column exists, is `not null default false`, and that
nothing was silently reclassified:

```sql
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'survey_photos'
   and column_name = 'customer_uploaded';

select count(*) filter (where customer_uploaded)       as customer_rows,
       count(*) filter (where not customer_uploaded)   as office_rows,
       count(*)                                        as total
  from public.survey_photos;
```

Expected: one column row, `boolean` / `NO` / `false`. And **`customer_rows` = 0**
— 0117 deliberately backfills nothing. Every pre-existing row must read as an
office photo, because that is bit-for-bit what every reader did before this
migration. A non-zero `customer_rows` on the FIRST run means something other
than this migration wrote the flag, and it needs explaining before the deploy:
a historic office ACCESS photo mis-stamped `true` silently disappears from the
crew day sheet, which is the exact failure the column exists to prevent.

Then the timeline stamp. It is nullable with no default and no backfill, and
that is correct rather than a gap: no survey has ever carried a customer photo,
so the first one to arrive genuinely is the first.

```sql
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public' and table_name = 'surveys'
   and column_name = 'customer_photos_noted_at';

select count(*) filter (where customer_photos_noted_at is not null) as noted_rows,
       count(*)                                                     as total
  from public.surveys;
```

Expected: one column row, `timestamp with time zone` / `YES` / null default, and
**`noted_rows` = 0** on the first run.

Then prove BOTH functions are there and locked down. `/cv` is an unauthenticated
surface and both of these write rows, so `anon` or `authenticated` in
`can_execute` is a finding, not a detail:

```sql
select p.proname, p.prosecdef, pg_get_function_result(p.oid) as returns,
       array(select rolname from pg_roles r
              where has_function_privilege(r.oid, p.oid, 'execute')
                and r.rolname in ('anon','authenticated','service_role','public')) as can_execute
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('add_customer_survey_photo', 'ensure_customer_survey_row')
 order by p.proname;
```

Expected: two rows, each with `prosecdef = t` and `can_execute` containing
**`service_role` only**.

```sql
-- Does the ceiling actually bite, and does the timeline marker survive a
-- delete? Rolls back either way; touches no real data.
begin;
  insert into public.surveys (lead_id, client_id, status)
       values (null, null, 'scheduled') returning id as probe_survey \gset
  select * from public.add_customer_survey_photo(:'probe_survey', 'probe/cubic/1.jpg', 2);
  select * from public.add_customer_survey_photo(:'probe_survey', 'probe/cubic/2.jpg', 2);
  select * from public.add_customer_survey_photo(:'probe_survey', 'probe/cubic/3.jpg', 2);
  -- The customer deletes everything and starts again. `is_first` must STAY false.
  delete from public.survey_photos where survey_id = :'probe_survey';
  select * from public.add_customer_survey_photo(:'probe_survey', 'probe/cubic/4.jpg', 2);
rollback;
```

Expected, in order:

| call | photo_id | capped | is_first | remaining |
|---|---|---|---|---|
| 1 | a uuid | `f` | **`t`** | 1 |
| 2 | a uuid | `f` | `f` | 0 |
| 3 | **null** | **`t`** | `f` | 0 |
| 4 (after the delete) | a uuid | `f` | **`f`** | 1 |

If the third call returns an id the ceiling is not enforced and the migration has
not done its job. Call 4 is the other half: `is_first` must come back **false**
even though the survey now holds zero photos again. `true` there means the marker
is still being derived from a live count, and a customer retaking one blurry shot
five times will write five identical "customer added photos" rows on the lead's
timeline.

Then the anchor row. Pick a lead that has no survey yet, so the CREATE half is
the half being exercised:

```sql
begin;
  select l.id as probe_lead
    from public.leads l
   where not exists (select 1 from public.surveys s where s.lead_id = l.id)
   order by l.created_at desc
   limit 1 \gset
  select public.ensure_customer_survey_row(:'probe_lead', null) as first_call \gset
  select public.ensure_customer_survey_row(:'probe_lead', null) as second_call \gset
  select :'first_call' = :'second_call'                                  as same_row,
         (select count(*) from public.surveys where lead_id = :'probe_lead') as survey_rows;
rollback;
```

Expected: `same_row = t` and `survey_rows = 1`. Two rows there would mean the
function is creating rather than finding on the second call, which is the defect
this replaced.

**What that probe does NOT prove**, and it matters: an advisory lock is
re-entrant within one session, so two calls down one psql connection both take it
and neither waits. The probe shows find-or-create is idempotent, not that it
serialises. For the serialisation itself, confirm the lock is actually in the
shipped body — it is the only line standing between two devices and two rows:

```sql
select pg_get_functiondef(p.oid) ilike '%pg_advisory_xact_lock%' as takes_the_lock
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname = 'ensure_customer_survey_row';
```

Expected: `t`.

App-side, after the deploy: send one photo through a real `/cv/<token>` link and
confirm (a) it appears in the customer's own gallery on that page, (b) it appears
in the office survey gallery on the lead's Survey tab, and (c) it does **not**
appear on that job's crew day sheet, while an estimator photo on the same survey
still does. (c) is the finding — the crew sheet reads oldest-first under a cap of
three, and the /cv link goes out before the survey visit, so customer photos
would otherwise push the crew's access shots off the sheet entirely.

**Staging note.** Any `/cv` photos uploaded to STAGING before this migration have
`customer_uploaded = false`, so they read as office photos and drop out of the
customer's gallery. That surface has never run in production, so the whole cost
is re-uploading a test photo; do not "fix" it with an `uploaded_by is null`
backfill, which is precisely the inference this migration refuses to make. For
the same reason those surveys' `customer_photos_noted_at` is null, so the next
staging upload writes one more "customer added photos" timeline row on a lead
that already had one. That is a staging artefact of the no-backfill rule, not a
regression; prod has no such rows.

---

## Activation (separate, later step — never part of the migration batch)

Pitmans goes `active = true` on prod only when the promoted build is verified, always BEFORE the prod import (PRD §5 cutover):

```sql
update brands set active = true where slug = 'pitmans';
select slug, active from brands where slug = 'pitmans';
```

One row, instantly reversible with `active = false` — deactivating reverts the entire brand UI.
