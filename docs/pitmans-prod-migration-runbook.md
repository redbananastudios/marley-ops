# Pitmans multi-brand — production migration runbook

**Who runs this: Peter, over SSH, on promotion day** — which is work-bound rather than dated (multi-brand PRD §5, §11.6): validated gates plus Peter's word, on a clear working day outside the 21–28 September import week. The build agent applies these files to STAGING only; production is human-only. Files apply **in order**, in one sitting, followed by the single `notify pgrst` (each file also carries its own where it matters — running it twice is harmless).

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
| 8 | **DEPLOY THE CODE** | not a migration — the promotion's container restart. It must happen HERE: after 0111 (which the new code writes to on every acceptance) and before 0110 (whose constraints the new code is what satisfies) | — |
| 9 | `supabase/migrations/0110_ledger_provider_checks.sql` | the CHECK constraints that make the stamp mandatory: a write that sets an id without its provider FAILS instead of silently claiming the wrong system | **YES, and in the opposite direction to everything above** — see the note below |

### 0111 must run BEFORE the deploy — and therefore before 0110

This is the mirror image of 0110's rule, so read both before running either.

From the moment the new code is live, BOTH accept paths write `payment_policy` in the
same UPDATE that marks a quote accepted. If the column does not exist yet, PostgREST
rejects that UPDATE — so the customer's own acceptance at `/q` and the office accepting
on their behalf BOTH fail, and the customer is told to phone in. Acceptance is the
single most expensive thing in this system to break.

That is why 0111 sits above the deploy row and 0110 sits below it, which means 0111
applies BEFORE 0110 despite the higher number. They are independent (unrelated tables
and columns), so the out-of-order run is safe — but it is deliberate, not a typo. Apply
in the order the table gives, not in filename order.

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

## Activation (separate, later step — never part of the migration batch)

Pitmans goes `active = true` on prod only when the promoted build is verified, always BEFORE the prod import (PRD §5 cutover):

```sql
update brands set active = true where slug = 'pitmans';
select slug, active from brands where slug = 'pitmans';
```

One row, instantly reversible with `active = false` — deactivating reverts the entire brand UI.
