-- 0065: harden contractor-invoice RLS for estimator self-invoicing + add the
-- cross-statement ledger key (2026-07-19 security review).
--
-- WHY: estimator self-invoicing reuses staff_statements/staff_statement_lines,
-- but estimators are is_office() (is_office = admin OR estimator). The 0056/0060
-- policies grant the entire OFFICE branch to is_office(), so an estimator holding
-- their own Supabase JWT could bypass every Next.js gate via direct PostgREST:
-- mark their OWN invoice paid, set an arbitrary total, read + tamper with every
-- crew member's pay, and skip the signed-agreement gate. The app layer already
-- blocks all of this — this moves the control into the database.
--
-- FIX: tighten the OFFICE branch of every staff_statements / staff_statement_lines
-- policy from is_office() to is_admin(). Estimators (and crew) then fall through
-- to the SAME self-scope crew already uses — own row only, draft only for writes,
-- and (writes) a signed contractor agreement — so they can build + submit ONLY
-- their own draft and can never pay/void/return or touch a colleague's pay. Only
-- an admin manages (mark paid / void / return) any invoice. This mirrors the
-- exact precedent in 0063 (staff_pay: is_office() -> is_admin() + self-scope).
--
-- Crew (role='crew') are NOT is_office(), so their behaviour is unchanged.

-- Cross-statement ledger key: which lead a computed line belongs to, so a fee is
-- billed at most once EVER across weekly statements (a job spanning a Mon week
-- boundary, or a re-quote in a later week, must not double-pay). survey lines
-- also carry appointment_id (pre-existing column) as their per-visit key.
alter table public.staff_statement_lines add column if not exists lead_id uuid;
create index if not exists staff_statement_lines_lead_idx
  on public.staff_statement_lines (lead_id) where lead_id is not null;

-- ---- STATEMENTS ---------------------------------------------------------------

drop policy if exists staff_statements_read on public.staff_statements;
create policy staff_statements_read on public.staff_statements for select
  using (is_admin() or staff_id in (select id from public.staff where profile_id = auth.uid()));

drop policy if exists staff_statements_insert on public.staff_statements;
create policy staff_statements_insert on public.staff_statements for insert
  with check (
    is_admin()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and status = 'draft'
      and public.has_signed_contractor_agreement()
    )
  );

drop policy if exists staff_statements_update on public.staff_statements;
create policy staff_statements_update on public.staff_statements for update
  using (
    is_admin()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and status = 'draft'
      and public.has_signed_contractor_agreement()
    )
  )
  with check (
    is_admin()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and status in ('draft', 'submitted')
      and public.has_signed_contractor_agreement()
    )
  );

drop policy if exists staff_statements_delete on public.staff_statements;
create policy staff_statements_delete on public.staff_statements for delete
  using (
    is_admin()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and status = 'draft'
      and public.has_signed_contractor_agreement()
    )
  );

-- ---- LINES --------------------------------------------------------------------

drop policy if exists staff_statement_lines_read on public.staff_statement_lines;
create policy staff_statement_lines_read on public.staff_statement_lines for select
  using (
    is_admin()
    or statement_id in (
      select s.id
      from public.staff_statements s
      join public.staff st on st.id = s.staff_id
      where st.profile_id = auth.uid()
    )
  );

drop policy if exists staff_statement_lines_write on public.staff_statement_lines;
create policy staff_statement_lines_write on public.staff_statement_lines for all
  using (
    is_admin()
    or (
      statement_id in (
        select s.id
        from public.staff_statements s
        join public.staff st on st.id = s.staff_id
        where st.profile_id = auth.uid() and s.status = 'draft'
      )
      and public.has_signed_contractor_agreement()
    )
  )
  with check (
    is_admin()
    or (
      statement_id in (
        select s.id
        from public.staff_statements s
        join public.staff st on st.id = s.staff_id
        where st.profile_id = auth.uid() and s.status = 'draft'
      )
      and public.has_signed_contractor_agreement()
    )
  );
