CREATE TABLE servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  hostname VARCHAR(255) NOT NULL,
  provider VARCHAR(100),
  location VARCHAR(100),
  virtualization_type VARCHAR(30) NOT NULL DEFAULT 'kvm',
  api_endpoint VARCHAR(500),
  credentials_ref VARCHAR(255),
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT servers_name_unique UNIQUE (name),
  CONSTRAINT servers_hostname_unique UNIQUE (hostname),
  CONSTRAINT servers_virtualization_type_check CHECK (virtualization_type IN ('kvm', 'lxc', 'openvz', 'xen', 'vmware', 'bare_metal', 'other')),
  CONSTRAINT servers_status_check CHECK (status IN ('active', 'maintenance', 'drain', 'offline', 'disabled'))
);

CREATE INDEX servers_status_idx ON servers (status);
CREATE INDEX servers_location_idx ON servers (location);

CREATE TRIGGER servers_set_updated_at
  BEFORE UPDATE ON servers
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
