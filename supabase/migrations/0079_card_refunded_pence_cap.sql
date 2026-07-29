-- Defence-in-depth for card refunds: refunded_pence must never exceed the
-- captured amount. App code already enforces this (refundBoundsError + the
-- atomic optimistic reserve in refundCardPayment), but a future service-role
-- write path would have no DB tripwire. This CHECK is that tripwire.
--
-- Apply to PROD alongside 0078 during the go-live migration step.
alter table card_payments
  add constraint card_payments_refunded_within_captured
  check (refunded_pence <= amount_pence);
