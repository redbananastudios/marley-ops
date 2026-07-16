-- Review 2026-07-16: the office-read policy exposed the ENTIRE bank statement
-- (outbound spend, supplier names, raw jsonb) to estimator-role users via
-- direct PostgREST, far beyond the inbound-only /payments surface. Estimators
-- keep the reconciliation rows (non-info); the full statement is admin-only.
drop policy if exists bank_transactions_read on bank_transactions;

create policy bank_transactions_read on bank_transactions for select using (
  is_admin() or (is_office() and status <> 'info')
);
