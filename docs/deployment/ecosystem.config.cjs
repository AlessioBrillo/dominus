// DOMINUS — PM2 ecosystem file for process management.
//
// Usage:
//   pm2 start ecosystem.config.cjs
//   pm2 save                           # persist the process list
//   pm2 startup                        # auto-start on boot
//
// For a multi-instance cluster (recommended for production):
//   pm2 start ecosystem.config.cjs -i max

module.exports = {
  apps: [
    {
      name: 'dominus',
      script: './dist/index.js',
      cwd: __dirname,

      // Environment variables (override in ecosystem.config.local.cjs)
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOST: '127.0.0.1',
        LOG_LEVEL: 'info',
        DATABASE_PATH: './data/dominus.db',
      },

      // Load .env file if present (PM2 merges this with env above)
      env_file: '.env',

      // Process management
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,

      // Logging
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: './logs/dominus-error.log',
      out_file: './logs/dominus-out.log',
      merge_logs: true,
      max_size: '10M',
      retain: 3,

      // Resource limits (requires PM2 >= 5.3)
      max_memory_restart: '512M',

      // Graceful shutdown
      kill_timeout: 10000,
      listen_timeout: 5000,
    },
  ],
};
