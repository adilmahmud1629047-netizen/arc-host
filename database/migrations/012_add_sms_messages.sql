CREATE TABLE sms_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  provider VARCHAR(30) NOT NULL,
  provider_message_id VARCHAR(255),
  provider_batch_id VARCHAR(255),
  recipient_hash CHAR(64) NOT NULL,
  message_type VARCHAR(50),
  status VARCHAR(30) NOT NULL DEFAULT 'sending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sms_messages_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT sms_messages_provider_check CHECK (provider ~ '^[a-z][a-z0-9_-]{0,29}$'),
  CONSTRAINT sms_messages_status_check CHECK (status IN ('sending', 'accepted', 'delivered', 'failed')),
  CONSTRAINT sms_messages_message_type_check CHECK (message_type IS NULL OR message_type ~ '^[a-z][a-z0-9_-]{0,49}$'),
  CONSTRAINT sms_messages_recipient_hash_check CHECK (recipient_hash ~ '^[0-9a-f]{64}$')
);

-- Audit log only: no message body, no phone numbers (sha256 hash only), no
-- credentials. Intentionally no plaintext recipient column — delivery tracking
-- and debugging work from the hash plus provider batch/message ids.

CREATE INDEX sms_messages_user_created_at_idx ON sms_messages (user_id, created_at DESC);
CREATE INDEX sms_messages_recipient_hash_idx ON sms_messages (recipient_hash);
CREATE INDEX sms_messages_status_created_at_idx ON sms_messages (status, created_at DESC);

CREATE TRIGGER sms_messages_set_updated_at
  BEFORE UPDATE ON sms_messages
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
