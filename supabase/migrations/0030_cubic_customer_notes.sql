-- 0030: split cubic-survey notes (review finding, 2026-07-10).
-- `notes` was one shared column: the office builder autosaves internal,
-- price-adjacent commentary into it, and the public /cv/<token> page rendered
-- it verbatim (and let the customer overwrite it). Office notes stay in
-- `notes` (never selected on /cv); the customer link reads/writes
-- `customer_notes` only, and the office sees both.

alter table cubic_surveys add column if not exists customer_notes text not null default '';
