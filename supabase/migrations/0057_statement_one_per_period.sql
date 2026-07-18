-- 0057: one LIVE statement per crew member per pay period (double-pay guard,
-- 2026-07-18 review). Without this a crew member could submit a statement for a
-- week, have it paid, then start + submit a SECOND for the same week — the
-- create-draft reuse only matched existing DRAFTS, so once the first was
-- submitted/paid nothing stopped a duplicate. Partial unique excludes 'void' so
-- a statement raised in error can be voided and the week re-raised cleanly.
create unique index if not exists staff_statements_one_per_period
  on public.staff_statements (staff_id, period_start, period_end)
  where status <> 'void';
