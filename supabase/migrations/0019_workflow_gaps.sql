-- Workflow-gap sweep (2026-07-09 review): customer decline, BACS self-report,
-- post-move review requests, and the Google review link setting.

-- Customer-side decline from the /q accept page (quote → rejected + why).
alter table quotes
  add column if not exists declined_at timestamptz,
  add column if not exists declined_reason text,
  -- Customer's "I've sent the bank transfer" self-report (staff still confirm).
  add column if not exists deposit_selfreport_at timestamptz;

-- One review ask per lead, ever.
alter table leads
  add column if not exists review_requested_at timestamptz;

-- The Google "write a review" link (same place id the website uses). Editable in
-- Settings; the post-move review email only sends when this is non-empty.
alter table business_settings
  add column if not exists google_review_url text not null
    default 'https://search.google.com/local/writereview?placeid=ChIJq8R84fCs_EkRc_9iHhFQXW8';
