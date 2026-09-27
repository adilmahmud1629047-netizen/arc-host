-- Step 13: admin foundation — harden users.role for admin authorization.
--
-- Reuses the existing `role` column from 001_create_users.sql:
--   role VARCHAR(20) NOT NULL DEFAULT 'customer'
--   CHECK (role IN ('customer', 'admin'))
--
-- This migration is idempotent and promotes NOBODY. It only re-asserts the
-- default and CHECK constraint so partial/legacy schemas cannot admit roles
-- outside {customer, admin}. Application code always inserts 'customer' for
-- registration; admin is granted manually (see README promotion procedure).

ALTER TABLE users
  ALTER COLUMN role SET DEFAULT 'customer';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'users_role_check'
      AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users
      ADD CONSTRAINT users_role_check CHECK (role IN ('customer', 'admin'));
  END IF;
END $$;
