-- 0062: at most one weekly-guarantee top-up line per statement (2026-07-19).
--
-- recomputeTotal reconciles the guarantee line by delete-then-insert across
-- separate round-trips. This partial unique index is the hard DB backstop so two
-- concurrent crew line-ops can never leave a statement with duplicate guarantee
-- lines — which would break the sum(lines)==total invariant and could overpay a
-- guaranteed crew member. The second racing insert fails loudly instead.
create unique index if not exists staff_statement_lines_one_guarantee
  on public.staff_statement_lines (statement_id)
  where source = 'guarantee';
