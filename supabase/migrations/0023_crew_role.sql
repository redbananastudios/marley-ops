-- Crew role — the third login tier (iMVE "Staff Management: can access assigned
-- jobs", docs/imve-discovery.md §4). Crew logins see ONLY /my-jobs (their
-- assigned appointments + job sheets); the dashboard layout redirects them out
-- of everything else. staff.profile_id links the crew record to the login.
alter type user_role add value if not exists 'crew';
