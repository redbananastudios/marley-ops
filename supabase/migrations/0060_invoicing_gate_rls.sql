-- 0060: move the contractor-invoicing gate into RLS (2026-07-18). The app layer
-- (meAsStaff → hasSignedCurrentAgreement) already blocks a crew member from
-- building/submitting an invoice before they've signed the contractor agreement,
-- but that gate lived ONLY in the Next.js server action — a crew member holding
-- their own Supabase JWT could bypass it with a direct PostgREST write. This adds
-- the gate to the row-level security on staff_statements / staff_statement_lines
-- so the "must have signed" rule is enforced at the database, not just the app.
--
-- The RLS check is existence-of-ANY signed agreement (has the worker ever signed)
-- — a robust backstop that can never itself break invoicing. The app still
-- enforces the precise CURRENT-version gate on top. Office writes are unaffected.

-- Security-definer helper (mirrors is_office()/is_staff()): does the caller have
-- a signed contractor agreement? Bypasses RLS on contractor_agreements so it is a
-- clean predicate to use inside other tables' policies.
create or replace function public.has_signed_contractor_agreement()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1 from public.contractor_agreements
    where profile_id = (select auth.uid())
  );
$function$;

revoke all on function public.has_signed_contractor_agreement() from public, anon;
grant execute on function public.has_signed_contractor_agreement() to authenticated, service_role;

-- Recreate the crew write policies with the agreement gate appended to the crew
-- branch (office branch unchanged). Same logic as 0056 otherwise.

drop policy if exists staff_statements_insert on public.staff_statements;
create policy staff_statements_insert on public.staff_statements for insert
  with check (
    is_office()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and status = 'draft'
      and public.has_signed_contractor_agreement()
    )
  );

drop policy if exists staff_statements_update on public.staff_statements;
create policy staff_statements_update on public.staff_statements for update
  using (
    is_office()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and status = 'draft'
      and public.has_signed_contractor_agreement()
    )
  )
  with check (
    is_office()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and status in ('draft', 'submitted')
      and public.has_signed_contractor_agreement()
    )
  );

drop policy if exists staff_statements_delete on public.staff_statements;
create policy staff_statements_delete on public.staff_statements for delete
  using (
    is_office()
    or (
      staff_id in (select id from public.staff where profile_id = auth.uid())
      and status = 'draft'
      and public.has_signed_contractor_agreement()
    )
  );

drop policy if exists staff_statement_lines_write on public.staff_statement_lines;
create policy staff_statement_lines_write on public.staff_statement_lines for all
  using (
    is_office()
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
    is_office()
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
