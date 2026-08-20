-- One "Create Quote" click made TWO drafts (QA-20260820-05).
--
-- createDraftQuote's resume-a-draft guard is a SELECT then INSERT with nothing
-- atomic behind it, and /quotes/new runs it during the page RENDER — which
-- Next.js can fire twice for one navigation (prefetch + the real request). Both
-- passes read "no draft yet" before either commits, so one estimator click
-- minted MMR014 AND MMR015 170ms apart on staging: a burned reference and an
-- orphan draft nobody ever opens. The application check stays as the fast path;
-- this index is the part that cannot race — the insert now catches the
-- violation and returns the winning row instead.
--
-- Dedupe first or the index cannot build: keep the NEWEST draft per lead (the
-- resume guard's own "newest draft wins" rule) and retire the rest as
-- superseded — history like every other retired quote, never deleted, because
-- a draft may hold pricing work someone already did.

update quotes q
set status = 'superseded'
where q.status = 'draft'
  and q.lead_id is not null
  and q.id <> (
    select q2.id
    from quotes q2
    where q2.lead_id = q.lead_id
      and q2.status = 'draft'
    order by q2.created_at desc, q2.id desc
    limit 1
  );

-- lead_id is nullable (pre-2026-07-11 orphan quotes) and NULLs never collide,
-- so this constrains exactly one live draft per LEAD and ignores the rest.
create unique index if not exists quotes_one_draft_per_lead_uq
  on quotes(lead_id)
  where status = 'draft';
