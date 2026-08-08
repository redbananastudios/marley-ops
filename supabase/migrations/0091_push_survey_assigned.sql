-- 0091: tell the ESTIMATOR when a survey is booked onto them (Peter, 2026-08-08
-- — "we should also send the estimator an SMS or an email or a push
-- notification when we book them in for a survey").
--
-- Until now the estimator was written onto the appointment and told nothing:
-- the customer got a confirmation naming them, the diary showed the visit, and
-- the only way the estimator learned of it was opening the panel. A survey
-- booked for tomorrow morning could sit unseen overnight.
--
-- Same shape as 0042's crew_job switch: one per-category kill column so the
-- push can be stopped instantly without a deploy.
alter table business_settings
  add column push_survey_assigned_enabled boolean not null default true;
