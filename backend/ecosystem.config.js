module.exports = {
  apps: [
    {
      name: 'flare-backend',
      script: 'src/server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
      time: true,
      out_file: 'logs/pm2-out.log',
      err_file: 'logs/pm2-err.log',
      merge_logs: true,
    },
  ],
};
