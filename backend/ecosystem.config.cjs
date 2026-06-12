// PM2 process config — kept in the repo and copied to /opt/drms/backend/ on deploy.
// cwd points at the current/ symlink so pm2 reload always runs from the newest release.
module.exports = {
  apps: [
    {
      name: "drms",
      script: "src/server.js",
      cwd: "/opt/drms/backend/current",
      interpreter: "node",

      instances: 1,
      exec_mode: "fork",

      // Pick up new env vars on reload (--update-env is also passed by Jenkinsfile)
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,

      env_production: {
        NODE_ENV: "production",
      },

      // Write logs to a stable location outside the release directory
      out_file: "/var/log/drms/out.log",
      error_file: "/var/log/drms/error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    },
  ],
};
