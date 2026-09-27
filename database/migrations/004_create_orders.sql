CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  order_number VARCHAR(32) NOT NULL,
  product_type VARCHAR(20) NOT NULL,
  product_id UUID NOT NULL,
  amount NUMERIC(12, 2) NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  billing_cycle VARCHAR(20) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT orders_order_number_unique UNIQUE (order_number),
  CONSTRAINT orders_product_type_check CHECK (product_type IN ('hosting', 'vps')),
  CONSTRAINT orders_amount_check CHECK (amount >= 0),
  CONSTRAINT orders_currency_check CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT orders_billing_cycle_check CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  CONSTRAINT orders_status_check CHECK (status IN ('pending', 'awaiting_payment', 'paid', 'cancelled', 'refunded', 'failed'))
);

CREATE INDEX orders_user_id_idx ON orders (user_id);
CREATE INDEX orders_status_idx ON orders (status);
CREATE INDEX orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX orders_product_idx ON orders (product_type, product_id);

CREATE TRIGGER orders_set_updated_at
  BEFORE UPDATE ON orders
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
