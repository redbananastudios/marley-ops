-- Lead full addresses + recorded phone estimate.
-- The website only sends postcodes; full pickup/destination addresses are captured
-- in the panel (needed for 3-leg mileage on the firm quote) and prefilled into the
-- survey + quote when one is created. `estimate_given` records the within-the-hour
-- phone ballpark Connor/Luke quote, so the attending estimator knows the number the
-- customer was already promised before the survey.

alter table leads add column if not exists from_address   text;
alter table leads add column if not exists to_address     text;
alter table leads add column if not exists estimate_given numeric(10,2);
