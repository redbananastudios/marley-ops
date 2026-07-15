-- 0045: account-level onboarding-tour flag (Peter, 2026-07-15).
--
-- The guided tour used to key "already seen" off localStorage only, so a new
-- device / reinstalled PWA / cleared browser re-fired it. The flag now lives on
-- the profile: stamped (once) when the user finishes OR dismisses their first
-- tour, checked server-side before auto-start. localStorage stays as a same-
-- device fast path. Manual relaunch via the small Tour button is unaffected.

alter table profiles add column tour_seen_at timestamptz;
