# Pitmans multi-brand — production migration runbook

**Who runs this: Peter, over SSH, on the 18 September promotion day** (multi-brand PRD §5, §11.6). The build agent applies these files to STAGING only; production is human-only. Files apply **in order**, in one sitting, followed by the single `notify pgrst` (each file also carries its own where it matters — running it twice is harmless).

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

---

## Activation (separate, later step — never part of the migration batch)

Pitmans goes `active = true` on prod only when the promoted build is verified, always BEFORE the prod import (PRD §5 cutover):

```sql
update brands set active = true where slug = 'pitmans';
select slug, active from brands where slug = 'pitmans';
```

One row, instantly reversible with `active = false` — deactivating reverts the entire brand UI.
