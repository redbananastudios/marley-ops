-- 0058: office "return to crew" for payment statements (2026-07-18).
--
-- Self-billing hinges on the crew GENERATING + CONFIRMING their own statement
-- (the IR35 mitigation). So the office must never silently rewrite a submitted
-- crew statement — instead it RETURNS it to the crew with a reason, and the crew
-- fix + re-submit (re-confirming). These two columns record that round-trip; the
-- status simply goes submitted -> draft, which the existing RLS already permits
-- for the office and re-opens crew editing (USING status='draft').
alter table public.staff_statements
  add column if not exists return_reason text,
  add column if not exists returned_at timestamptz;
