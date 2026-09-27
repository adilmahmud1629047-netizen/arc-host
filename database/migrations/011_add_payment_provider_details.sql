ALTER TABLE payment_transactions
  ADD COLUMN IF NOT EXISTS provider_session_key VARCHAR(512),
  ADD COLUMN IF NOT EXISTS validation_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS bank_transaction_id VARCHAR(255);
