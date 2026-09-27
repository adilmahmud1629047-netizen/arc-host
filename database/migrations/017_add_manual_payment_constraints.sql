-- Manual payment verification (transaction-id submission → admin review).
-- A customer may have at most ONE pending manual submission per order; a
-- second submission must fail with a unique violation instead of silently
-- stacking rows. Two other guarantees already exist from migration 010:
--   * payment_transactions_provider_tx_unique
--       (provider, provider_transaction_id) WHERE provider_transaction_id
--       IS NOT NULL  → one Transaction ID per provider, ever;
--   * payment_transactions_one_success_per_order
--       (order_id) WHERE status = 'successful' → never two paid rows.
CREATE UNIQUE INDEX IF NOT EXISTS payment_transactions_manual_pending_order
  ON payment_transactions (order_id)
  WHERE provider = 'manual' AND status = 'pending';
