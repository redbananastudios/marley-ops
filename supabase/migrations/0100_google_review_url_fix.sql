-- The post-move review email was sending customers to the wrong Google
-- listing: 0019 seeded business_settings.google_review_url with
-- search.google.com/local/writereview?placeid=ChIJq8R84fCs… and the stored
-- row still carried it, overriding the corrected constant in code on every
-- send (caught by Peter, 2026-08-19). Point the stored value and the column
-- default at the canonical GBP "write a review" short link. The UPDATE is
-- conditional on the known-bad value so a hand-edited setting is never
-- clobbered.

alter table business_settings
  alter column google_review_url
    set default 'https://g.page/r/CXD_Yh4RUF1cEBM/review';

update business_settings
  set google_review_url = 'https://g.page/r/CXD_Yh4RUF1cEBM/review'
  where google_review_url = 'https://search.google.com/local/writereview?placeid=ChIJq8R84fCs_EkRc_9iHhFQXW8';
