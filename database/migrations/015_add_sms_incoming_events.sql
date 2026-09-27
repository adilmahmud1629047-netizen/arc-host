-- Incoming TextBee SMS events (webhook foundation for future payment
-- verification). Separate from sms_messages (012), which is outbound-only
-- (no body, hash-only recipient, no direction). Incoming rows are NEVER
-- payment proof and never change order status.

CREATE TABLE IF NOT EXISTS sms_incoming_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(30) NOT NULL,
  provider_message_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255) NOT NULL,
  webhook_event VARCHAR(40) NOT NULL DEFAULT 'MESSAGE_RECEIVED',
  direction VARCHAR(20) NOT NULL DEFAULT 'received',
  sender VARCHAR(64),
  message_body TEXT NOT NULL,
  received_at TIMESTAMPTZ,
  device_id VARCHAR(255),
  webhook_subscription_id VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'received',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sms_incoming_events_provider_check
    CHECK (provider ~ '^[a-z][a-z0-9_-]{0,29}$'),
  CONSTRAINT sms_incoming_events_status_check
    CHECK (status IN ('received', 'unverified')),
  CONSTRAINT sms_incoming_events_direction_check
    CHECK (direction IN ('received')),
  CONSTRAINT sms_incoming_events_event_check
    CHECK (webhook_event IN ('MESSAGE_RECEIVED')),
  CONSTRAINT sms_incoming_events_message_len_check
    CHECK (char_length(message_body) BETWEEN 1 AND 1600)
);

-- Webhook retries: same TextBee idempotencyKey → one row only.
CREATE UNIQUE INDEX IF NOT EXISTS sms_incoming_events_provider_idempotency_key
  ON sms_incoming_events (provider, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS sms_incoming_events_provider_message_id
  ON sms_incoming_events (provider, provider_message_id);

CREATE INDEX IF NOT EXISTS sms_incoming_events_created_at_idx
  ON sms_incoming_events (created_at DESC);

CREATE INDEX IF NOT EXISTS sms_incoming_events_status_created_at_idx
  ON sms_incoming_events (status, created_at DESC);

DROP TRIGGER IF EXISTS sms_incoming_events_set_updated_at ON sms_incoming_events;
CREATE TRIGGER sms_incoming_events_set_updated_at
  BEFORE UPDATE ON sms_incoming_events
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
