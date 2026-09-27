-- Extend sms_incoming_events.status for the bKash payment pipeline (step 16).
-- Existing rows keep their values; only the allowed vocabulary grows.
-- Statuses: received → unverified | parsed → matched | verified
--           rejected | ambiguous (manual review — never auto-paid).

ALTER TABLE sms_incoming_events
  DROP CONSTRAINT IF EXISTS sms_incoming_events_status_check;

ALTER TABLE sms_incoming_events
  ADD CONSTRAINT sms_incoming_events_status_check
  CHECK (status IN (
    'received',
    'unverified',
    'parsed',
    'matched',
    'verified',
    'rejected',
    'ambiguous'
  ));
