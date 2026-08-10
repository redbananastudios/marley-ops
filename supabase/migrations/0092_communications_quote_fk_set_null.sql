-- Deleting a SENT quote was impossible.
--
-- communications.quote_id referenced quotes with NO ACTION, and every sent quote
-- has at least one outbound email against it, so the delete always aborted with
-- 'violates foreign key constraint "communications_quote_id_fkey"' — a raw
-- Postgres string shown to the office after a dialog that said "Delete anyway".
-- (Peter, 2026-08-10.)
--
-- SET NULL, not CASCADE: the email genuinely reached the customer and the record
-- of it is the audit trail. The quote row can go; what we told them cannot.
--
-- card_payments and refund_queue deliberately keep RESTRICT — those are real
-- money and SHOULD block a delete. deleteQuote now checks them up front so the
-- office gets a sentence instead of a constraint name.

alter table communications
  drop constraint if exists communications_quote_id_fkey;

alter table communications
  add constraint communications_quote_id_fkey
  foreign key (quote_id) references quotes(id) on delete set null;
