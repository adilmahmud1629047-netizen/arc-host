ALTER TABLE hosting_plans
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'BDT';

ALTER TABLE hosting_plans
  ADD CONSTRAINT hosting_plans_currency_check CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE hosting_plans
  ALTER COLUMN domains DROP NOT NULL,
  ALTER COLUMN email_accounts DROP NOT NULL,
  ALTER COLUMN databases DROP NOT NULL;

ALTER TABLE vps_plans
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'BDT';

ALTER TABLE vps_plans
  ADD CONSTRAINT vps_plans_currency_check CHECK (currency ~ '^[A-Z]{3}$');
