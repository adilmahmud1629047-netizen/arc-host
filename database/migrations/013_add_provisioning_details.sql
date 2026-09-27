-- Step 12: provisioning architecture columns on service_instances.
--
-- Reuses the existing `status` lifecycle column (migration 006):
--   provisioning -> active | failed   (initial provisioning outcome)
--   active       -> suspended | terminated
--   suspended    -> active | terminated
--   failed / terminated are terminal.
-- "pending" (paid order, no service yet) is represented by the ABSENCE of a
-- row — no schema change needed for it.
--
-- Added here:
--   provider               — which provisioning provider created the instance
--                             (e.g. disabled/proxmox/whm — never a secret)
--   provisioned_at/suspended_at/terminated_at — lifecycle audit timestamps
--   failure_code/failure_message_safe        — OUR normalized safe diagnostic
--                             only; never raw provider responses or secrets
--   order_id UNIQUE        — idempotency: one service instance per paid order
--
-- Reuses existing columns (NOT duplicated): external_id (provider resource
-- id), server_id, hostname, plan FKs. No credentials of any kind are stored.

ALTER TABLE service_instances
  ADD COLUMN IF NOT EXISTS provider VARCHAR(32),
  ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failure_code VARCHAR(64),
  ADD COLUMN IF NOT EXISTS failure_message_safe VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS service_instances_order_id_unique
  ON service_instances (order_id)
  WHERE order_id IS NOT NULL;
