-- Admin product management (STEP 45). Extends the existing plan tables instead
-- of introducing a second product system:
--   * hosting_plans.category separates web hosting from Minecraft hosting
--     (Minecraft orders keep product_type='hosting'; the order flow is
--     unchanged and keyed by product_type + slug);
--   * display_order / popular make list ordering and the public "Popular"
--     badge data-driven instead of a position heuristic;
--   * cpu_cores / ram_mb (nullable) let Minecraft products carry vCPU/RAM
--     specs that minecraft-page.js already renders when present.
-- Existing rows are backfilled to category='web', display_order=0,
-- popular=false by the ADD COLUMN defaults.
ALTER TABLE hosting_plans
  ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'web',
  ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN popular BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN cpu_cores INTEGER,
  ADD COLUMN ram_mb INTEGER;

ALTER TABLE hosting_plans
  ADD CONSTRAINT hosting_plans_category_check CHECK (category IN ('web', 'minecraft')),
  ADD CONSTRAINT hosting_plans_cpu_cores_check CHECK (cpu_cores IS NULL OR cpu_cores > 0),
  ADD CONSTRAINT hosting_plans_ram_mb_check CHECK (ram_mb IS NULL OR ram_mb >= 64);

ALTER TABLE vps_plans
  ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN popular BOOLEAN NOT NULL DEFAULT false;
