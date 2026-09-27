-- Optional client idempotency key for safe order retries (scoped per user).
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS orders_user_idempotency_key_unique
  ON orders (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
