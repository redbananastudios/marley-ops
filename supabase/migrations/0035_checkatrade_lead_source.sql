-- Add Checkatrade as a lead entry channel, alongside google/facebook/phone/etc.
-- Enables per-source review routing (a Checkatrade lead is asked for a
-- Checkatrade review; everyone else defaults to Google).
alter type lead_entry_channel add value if not exists 'checkatrade';
