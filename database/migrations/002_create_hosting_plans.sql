CREATE TABLE hosting_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'monthly',
  storage_gb INTEGER NOT NULL DEFAULT 0,
  bandwidth_gb INTEGER,
  domains INTEGER NOT NULL DEFAULT 1,
  email_accounts INTEGER NOT NULL DEFAULT 0,
  databases INTEGER NOT NULL DEFAULT 0,
  ssl BOOLEAN NOT NULL DEFAULT true,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hosting_plans_slug_unique UNIQUE (slug),
  CONSTRAINT hosting_plans_slug_format_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT hosting_plans_price_check CHECK (price >= 0),
  CONSTRAINT hosting_plans_billing_cycle_check CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  CONSTRAINT hosting_plans_storage_check CHECK (storage_gb > 0),
  CONSTRAINT hosting_plans_bandwidth_check CHECK (bandwidth_gb IS NULL OR bandwidth_gb >= 0),
  CONSTRAINT hosting_plans_domains_check CHECK (domains >= 0),
  CONSTRAINT hosting_plans_email_accounts_check CHECK (email_accounts >= 0),
  CONSTRAINT hosting_plans_databases_check CHECK (databases >= 0),
  CONSTRAINT hosting_plans_status_check CHECK (status IN ('active', 'inactive', 'archived'))
);

CREATE INDEX hosting_plans_status_idx ON hosting_plans (status);
CREATE INDEX hosting_plans_price_idx ON hosting_plans (price);

CREATE TRIGGER hosting_plans_set_updated_at
  BEFORE UPDATE ON hosting_plans
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
