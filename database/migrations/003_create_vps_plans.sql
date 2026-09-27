CREATE TABLE vps_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) NOT NULL,
  description TEXT,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
  billing_cycle VARCHAR(20) NOT NULL DEFAULT 'monthly',
  cpu_cores INTEGER NOT NULL DEFAULT 1,
  ram_mb INTEGER NOT NULL DEFAULT 1024,
  storage_gb INTEGER NOT NULL DEFAULT 20,
  bandwidth_gb INTEGER,
  ipv4_addresses INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT vps_plans_slug_unique UNIQUE (slug),
  CONSTRAINT vps_plans_slug_format_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT vps_plans_price_check CHECK (price >= 0),
  CONSTRAINT vps_plans_billing_cycle_check CHECK (billing_cycle IN ('monthly', 'quarterly', 'yearly')),
  CONSTRAINT vps_plans_cpu_cores_check CHECK (cpu_cores > 0),
  CONSTRAINT vps_plans_ram_mb_check CHECK (ram_mb > 0),
  CONSTRAINT vps_plans_storage_gb_check CHECK (storage_gb > 0),
  CONSTRAINT vps_plans_bandwidth_gb_check CHECK (bandwidth_gb IS NULL OR bandwidth_gb >= 0),
  CONSTRAINT vps_plans_ipv4_addresses_check CHECK (ipv4_addresses >= 1),
  CONSTRAINT vps_plans_status_check CHECK (status IN ('active', 'inactive', 'archived'))
);

CREATE INDEX vps_plans_status_idx ON vps_plans (status);
CREATE INDEX vps_plans_price_idx ON vps_plans (price);

CREATE TRIGGER vps_plans_set_updated_at
  BEFORE UPDATE ON vps_plans
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
