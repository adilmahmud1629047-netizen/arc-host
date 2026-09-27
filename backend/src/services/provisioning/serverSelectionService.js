const config = require('../../config');
const { query } = require('../../config/database');

// Server selection abstraction — deliberately simple for Step 12:
// no load-balancing algorithm, no capacity scoring.
//
// Returns the first ACTIVE server for VPS placement, or null when none is
// available (or provisioning is disabled — never assign a fake production
// server just because rows exist). Hosting accounts are not placed on the
// servers table yet, so hosting always gets null.
//
// Future selection can additionally consider, once the schema tracks them:
//   - available CPU / RAM / storage / bandwidth capacity per server
//   - service type / virtualization type fit (kvm, lxc, ...)
//   - node health and reachability
//   - capacity headroom and fair distribution
//   - maintenance / drain / offline state (already filtered via status)
async function selectServer(serviceType, resources = {}) {
  if (serviceType !== 'vps') return null;

  const providerId = ((config.provisioning &&
    config.provisioning.provider) ||
    'disabled'
  )
    .trim()
    .toLowerCase();
  if (providerId === 'disabled') return null;

  const { rows } = await query(
    `SELECT id, name
     FROM servers
     WHERE status = 'active'
     ORDER BY created_at ASC, name ASC
     LIMIT 1`,
    []
  );
  return rows[0] || null;
}

module.exports = { selectServer };
