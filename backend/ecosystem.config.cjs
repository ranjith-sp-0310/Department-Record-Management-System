// PM2 ecosystem file — must be .cjs because the project uses "type": "module"
// Deploy:   pm2 start ecosystem.config.cjs
// Reload:   pm2 reload ecosystem.config.cjs --update-env
// Logs:     pm2 logs drms

module.exports = {
  apps: [
    {
      name: "drms",
      script: "src/server.js",

      // Load OTel instrumentation before any app module is imported
      node_args: "--import ./src/otel.js",

      // Keep a working directory so relative paths resolve correctly
      cwd: "/opt/drms/backend/current",

      // Restart if process exceeds 512 MB (guards against memory leaks)
      max_memory_restart: "512M",

      // Wait 5 s before marking the process as online (lets the DB pool warm up)
      min_uptime: "5s",
      max_restarts: 5,

      // Merge stdout + stderr into one stream for Filebeat / ECS log shipping
      merge_logs: true,
      log_date_format: "YYYY-MM-DDTHH:mm:ss.SSSZ",

      env_production: {
        NODE_ENV: "production",
        PORT: 5000,
        OTEL_SERVICE_NAME: "drms-backend",
        // Set OTEL_EXPORTER_OTLP_ENDPOINT in /opt/drms/backend/.env
        // e.g. OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
      },
    },
  ],
};
