const path = require('path');

module.exports = {
  apps: [
    {
      name: 'asset-manager',
      cwd: path.resolve(__dirname),
      script: './dist/index.cjs',
      instances: 1, // Set to 'max' for cluster mode, or a number for specific instances
      exec_mode: 'fork', // 'fork' for single instance, 'cluster' for multiple
      env: {
        NODE_ENV: 'production',
        PORT: 5000,
        HOST: '0.0.0.0', // Listen on all interfaces
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 5000,
        HOST: '0.0.0.0', // Listen on all interfaces
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 5000,
        HOST: '0.0.0.0', // Listen on all interfaces
      },
      // Logging
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_file: './logs/pm2-combined.log',
      time: true, // Prepend timestamp to logs
      merge_logs: true,
      
      // Auto-restart settings
      autorestart: true,
      watch: false, // Set to true for development, false for production
      max_memory_restart: '1G', // Restart if memory exceeds 1GB
      
      // Advanced settings
      min_uptime: '10s', // Minimum uptime to consider app stable
      max_restarts: 10, // Maximum restarts in 1 minute
      restart_delay: 4000, // Delay between restarts (ms)
      
      // Graceful shutdown
      kill_timeout: 5000, // Time to wait for graceful shutdown
      wait_ready: false, // Set to true if your app emits 'ready' event
      listen_timeout: 10000, // Time to wait for app to start
    },
    // Development mode configuration (optional)
    {
      name: 'asset-manager-dev',
      cwd: path.resolve(__dirname),
      script: 'tsx',
      args: 'server/index.ts',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'development',
        PORT: 5000,
        HOST: '0.0.0.0', // Listen on all interfaces
      },
      error_file: './logs/pm2-dev-error.log',
      out_file: './logs/pm2-dev-out.log',
      log_file: './logs/pm2-dev-combined.log',
      time: true,
      merge_logs: true,
      autorestart: true,
      watch: true, // Watch for file changes in development
      watch_delay: 1000,
      ignore_watch: [
        'node_modules',
        'logs',
        'dist',
        '.git',
        'uploads',
      ],
      max_memory_restart: '1G',
    },
  ],
};
