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
| 2 | `supabase/migrations/0106_ingest_brand.sql` | replaces 0102's global unique index on `leads.external_lead_id` with `leads_external_lead_brand_uq` on `(brand, external_lead_id)` — two brands' websites can mint the same submission id without the second being silently swallowed as a duplicate of the first | No — index swap on a small table; creates the new index before dropping the old, so uniqueness never lapses |

*(rows appended per gate)*

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

---

## Activation (separate, later step — never part of the migration batch)

Pitmans goes `active = true` on prod only when the promoted build is verified, always BEFORE the prod import (PRD §5 cutover):

```sql
update brands set active = true where slug = 'pitmans';
select slug, active from brands where slug = 'pitmans';
```

One row, instantly reversible with `active = false` — deactivating reverts the entire brand UI.
