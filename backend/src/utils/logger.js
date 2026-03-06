// src/utils/logger.js
import { createLogger, transports } from "winston";
import { ecsFormat } from "@elastic/ecs-winston-format";

const NODE_ENV = process.env.NODE_ENV || "development";

// Prefer the version npm injects at startup; fall back to the env var or a
// sentinel so it's obvious when neither is set rather than silently logging "1.0.0".
const SERVICE_VERSION =
  process.env.npm_package_version ||
  process.env.SERVICE_VERSION ||
  "unknown";

// ECS (Elastic Common Schema) format — produces structured JSON that Logstash,
// Filebeat, and the Elastic Stack can ingest without any additional mapping.
// convertReqRes: true makes the formatter automatically map Express req/res
// objects to ECS http.* and url.* fields when passed as log metadata.
const logger = createLogger({
  level: process.env.LOG_LEVEL || (NODE_ENV === "production" ? "info" : "debug"),
  format: ecsFormat({ convertReqRes: true }),
  defaultMeta: {
    "service.name": process.env.SERVICE_NAME || "drms-backend",
    "service.version": SERVICE_VERSION,
    "service.environment": NODE_ENV,
  },
  transports: [
    // Logs to stdout — consumed by Docker/systemd/PM2 and forwarded to Elastic
    // via Filebeat or a Logstash pipeline configured to read from stdout/file.
    new transports.Console(),
  ],
});

export default logger;
