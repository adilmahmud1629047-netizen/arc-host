CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL,
  user_id UUID NOT NULL,
  provider VARCHAR(30) NOT NULL,
  provider_transaction_id VARCHAR(255),
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'initiated',
  payment_method VARCHAR(50),
  initiated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_transactions_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT payment_transactions_provider_check CHECK (provider ~ '^[a-z][a-z0-9_-]{0,29}$'),
  CONSTRAINT payment_transactions_status_check CHECK (status IN ('initiated', 'pending', 'successful', 'failed', 'cancelled', 'expired', 'refunded')),
  CONSTRAINT payment_transactions_amount_check CHECK (amount >= 0),
  CONSTRAINT payment_transactions_currency_check CHECK (currency ~ '^[A-Z]{3}$')
);

-- Webhook idempotency: a provider transaction id may be recorded only once.
CREATE UNIQUE INDEX payment_transactions_provider_tx_unique
  ON payment_transactions (provider, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;

-- At most one verified successful payment per order.
CREATE UNIQUE INDEX payment_transactions_one_success_per_order
  ON payment_transactions (order_id)
  WHERE status = 'successful';

CREATE INDEX payment_transactions_order_id_idx ON payment_transactions (order_id);
CREATE INDEX payment_transactions_user_created_at_idx ON payment_transactions (user_id, created_at DESC);

CREATE TRIGGER payment_transactions_set_updated_at
  BEFORE UPDATE ON payment_transactions
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
