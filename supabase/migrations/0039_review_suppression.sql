-- 0039: post-move review-request suppression (Peter, 2026-07-14).
-- A per-job switch that stops the automatic review-request email for a
-- customer who wasn't fully satisfied. Set by the office toggle on the lead
-- page, and auto-set true when the crew record exceptions at completion
-- sign-off (a missed review ask is cheap; asking an unhappy customer isn't).
-- sendReviewRequest() bails before its claim when this is true.
--
-- No RLS change: leads_update (is_staff()) already lets the office update the
-- lead; the crew auto-suppress path writes via the service-role admin client.

alter table leads
  add column review_suppressed boolean not null default false;

comment on column leads.review_suppressed is
  'When true, the automatic post-move review-request email is skipped for this job. Set by the office toggle or auto-set when exceptions are recorded at completion sign-off.';
