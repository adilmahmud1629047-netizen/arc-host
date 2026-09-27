const config = require('../config');
const { healthCheck } = require('../config/database');

async function getHealth(req, res) {
  const databaseUp = await healthCheck();

  res.status(200).json({
    status: 'ok',
    service: 'flare-hosting-api',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    environment: config.env,
    database: databaseUp ? 'up' : 'down',
  });
}

module.exports = { getHealth };
