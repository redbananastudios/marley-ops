-- Crew pricing lockdown + night-before reminders.
--
-- Peter (2026-07-10): "Crew do not need to see any pricing data at all."
-- is_staff() lets ANY active profile read everything, so a crew login could
-- read quotes/rates through the API even though the UI hides them. New
-- is_office() (admin | estimator) gates every money-bearing table; crew keep
-- what /my-jobs needs (appointments, assignments, leads, staff, vehicles).
-- The job-sheet server action reads quotes via the SERVICE ROLE and returns
-- only price-free fields, so crew job sheets still work.

create or replace function is_office() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and active and role in ('admin', 'estimator')
  );
$$;

do $$
declare t text;
begin
  foreach t in array array['quotes', 'business_settings', 'estimator_payouts', 'storage_lets'] loop
    execute format('drop policy if exists %1$s_read on %1$s;', t);
    execute format('create policy %1$s_read on %1$s for select using (is_office());', t);
  end loop;
end $$;

-- Crew can't write money rows either (deletes were already admin-only).
drop policy if exists quotes_insert on quotes;
create policy quotes_insert on quotes for insert with check (is_office());
drop policy if exists quotes_update on quotes;
create policy quotes_update on quotes for update using (is_office());
drop policy if exists storage_lets_insert on storage_lets;
create policy storage_lets_insert on storage_lets for insert with check (is_office());
drop policy if exists storage_lets_update on storage_lets;
create policy storage_lets_update on storage_lets for update using (is_office());

-- Night-before crew reminder: stamped when the email goes out so the cron
-- never reminds the same assignment twice.
alter table appointment_assignments add column if not exists reminded_at timestamptz;
