CREATE TABLE service_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  order_id UUID,
  service_type VARCHAR(20) NOT NULL,
  hosting_plan_id UUID,
  vps_plan_id UUID,
  server_id UUID,
  external_id VARCHAR(255),
  hostname VARCHAR(255),
  status VARCHAR(30) NOT NULL DEFAULT 'provisioning',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_instances_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE RESTRICT,
  CONSTRAINT service_instances_order_fk FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE RESTRICT,
  CONSTRAINT service_instances_hosting_plan_fk FOREIGN KEY (hosting_plan_id) REFERENCES hosting_plans (id) ON DELETE RESTRICT,
  CONSTRAINT service_instances_vps_plan_fk FOREIGN KEY (vps_plan_id) REFERENCES vps_plans (id) ON DELETE RESTRICT,
  CONSTRAINT service_instances_server_fk FOREIGN KEY (server_id) REFERENCES servers (id) ON DELETE RESTRICT,
  CONSTRAINT service_instances_service_type_check CHECK (service_type IN ('hosting', 'vps')),
  CONSTRAINT service_instances_status_check CHECK (status IN ('provisioning', 'active', 'suspended', 'terminated', 'failed')),
  CONSTRAINT service_instances_plan_pairing_check CHECK (
    (service_type = 'hosting' AND hosting_plan_id IS NOT NULL AND vps_plan_id IS NULL)
    OR
    (service_type = 'vps' AND vps_plan_id IS NOT NULL AND hosting_plan_id IS NULL)
  ),
  CONSTRAINT service_instances_vps_requires_server_check CHECK (
    service_type = 'hosting' OR server_id IS NOT NULL
  )
);

CREATE INDEX service_instances_user_id_idx ON service_instances (user_id);
CREATE INDEX service_instances_order_id_idx ON service_instances (order_id);
CREATE INDEX service_instances_server_id_idx ON service_instances (server_id);
CREATE INDEX service_instances_status_idx ON service_instances (status);
CREATE INDEX service_instances_service_type_idx ON service_instances (service_type);

CREATE UNIQUE INDEX service_instances_server_external_unique
  ON service_instances (server_id, external_id)
  WHERE server_id IS NOT NULL AND external_id IS NOT NULL;

CREATE TRIGGER service_instances_set_updated_at
  BEFORE UPDATE ON service_instances
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
