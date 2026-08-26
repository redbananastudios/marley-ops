-- Phase 0 value landing: the Pitmans WebEx alphanumeric SMS sender id.
--
-- 0104 seeded the pitmans row with sms_sender NULL because the sender did not
-- exist yet ("Phase 0 blank"). Peter created it in WebEx Interact on
-- 2026-08-26, so the value can now land.
--
-- WHY THIS IS A MIGRATION AND NOT A SETTINGS EDIT: sms_sender is deliberately
-- outside sanitizeBrandUpdate's whitelist (lib/brand-update.ts) — that list is
-- presentation-only, and email/SMS identities are excluded on purpose because
-- they feed comms correctness. It is also not a by-hand staging tweak like the
-- active=true flip, because this value must reach PROD too, and the runbook is
-- how prod gets changes.
--
-- WHAT IT FIXES: lib/comms/send.ts smsSenderFor() resolves
--   brand.smsSender || WEBEX_SMS_SENDER_MARLEY_MOVES || WEBEX_SMS_SENDER
-- so while this column was null EVERY Pitmans SMS — including the deposit and
-- balance payment chases, whose bodies already say "Pitmans Removals & Storage
-- here" — was delivered fronted by MARLEY'S sender id, and customer replies
-- landed on Marley's SMS rail. Filed as QA-20260826-08. This closes the live
-- exposure; the fail-open fallback itself is a separate decision for Peter
-- (that finding stays open), because refusing to send is a behaviour change on
-- a money-chase channel.
--
-- MARLEY IS UNTOUCHED, twice over: the update is slug-scoped, and smsSenderFor
-- ignores brands.sms_sender entirely for the default brand
-- (`brand.slug !== DEFAULT_BRAND ? brand.smsSender : null`), so even a value
-- set on the marley row could not change today's Marley sends.
--
-- No `notify pgrst, 'reload schema'` here, and that is deliberate rather than
-- forgotten: this is a data-only UPDATE. PostgREST caches the SCHEMA, and no
-- column, type or function changes, so there is nothing to reload.
--
-- Re-runnable: setting the same value twice is a no-op.

update brands
   set sms_sender = 'Pitmans'
 where slug = 'pitmans';
