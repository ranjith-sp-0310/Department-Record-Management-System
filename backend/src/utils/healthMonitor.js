import pool, { getPoolHealth } from "../config/db.js";
import { transporter, isMailConfigured } from "../config/mailer.js";
import { STORAGE_PATH } from "../config/upload.js";
import { peekSnapshot } from "./metricsBuffer.js";
import fs from "fs";
import path from "path";
import logger from "./logger.js";

const MIN_REQUESTS_FOR_ANOMALY = 10;
const ANOMALY_ERROR_RATE_PCT  = Number(process.env.ANOMALY_ERROR_RATE_PCT)  || 10;
const ANOMALY_P95_LATENCY_MS  = Number(process.env.ANOMALY_P95_LATENCY_MS)  || 2000;
const ANOMALY_AUTH_FAILURES   = Number(process.env.ANOMALY_AUTH_FAILURES)   || 20;
const ANOMALY_TRAFFIC_SPIKE   = Number(process.env.ANOMALY_TRAFFIC_SPIKE)   || 500;

const firingAlerts = new Map();
// Counts how many consecutive check cycles each anomaly has been failing.
// Resets to 0 on the first passing cycle.
const consecutiveFailures = new Map();

// Core tables the app cannot function without
const CORE_TABLES = [
  "users", "otp_verifications", "user_sessions", "projects",
  "achievements", "events", "faculty_participations",
  "faculty_research", "faculty_consultancy", "student_profiles",
];

async function checkDatabase() {
  // Verify pool is not in critical state
  const ph = getPoolHealth();
  if (ph.health.status === "critical") {
    throw new Error("Pool critical — utilization high or error rate elevated");
  }
  // Verify DB is writable (not a read-only replica or disk-full standby)
  const { rows } = await pool.query("SELECT pg_is_in_recovery() AS is_replica");
  if (rows[0].is_replica) throw new Error("Database is in read-only / recovery mode");
}

async function checkCoreTables() {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [CORE_TABLES],
  );
  const found = new Set(rows.map((r) => r.table_name));
  const missing = CORE_TABLES.filter((t) => !found.has(t));
  if (missing.length > 0) throw new Error(`Missing tables: ${missing.join(", ")}`);
}

async function checkEmail() {
  if (!isMailConfigured) {
    throw new Error("Email service not configured (EMAIL_USER/EMAIL_PASS missing)");
  }
  await transporter.verify();
}

async function checkStorage() {
  fs.accessSync(STORAGE_PATH, fs.constants.R_OK | fs.constants.W_OK);
  // Test actual write
  const testFile = path.join(STORAGE_PATH, `.health-${Date.now()}`);
  fs.writeFileSync(testFile, "ok");
  fs.unlinkSync(testFile);
  // Check disk usage — alert at 90%
  const stats = await fs.promises.statfs(STORAGE_PATH);
  const usedPct = Math.round((1 - stats.bavail / stats.blocks) * 100);
  if (usedPct >= 90) throw new Error(`Disk usage at ${usedPct}% — uploads may fail`);
}

function checkErrorRate() {
  const { totalRequests, serverErrors } = peekSnapshot();
  if (totalRequests < MIN_REQUESTS_FOR_ANOMALY) return;
  const pct = (serverErrors / totalRequests) * 100;
  if (pct > ANOMALY_ERROR_RATE_PCT) {
    throw new Error(`Server error rate ${pct.toFixed(1)}% exceeds threshold ${ANOMALY_ERROR_RATE_PCT}% (${serverErrors}/${totalRequests} requests)`);
  }
}

function checkLatency() {
  const { totalRequests, p95LatencyMs } = peekSnapshot();
  if (totalRequests < MIN_REQUESTS_FOR_ANOMALY) return;
  if (p95LatencyMs > ANOMALY_P95_LATENCY_MS) {
    throw new Error(`p95 latency ${p95LatencyMs}ms exceeds threshold ${ANOMALY_P95_LATENCY_MS}ms`);
  }
}

function checkAuthFailures() {
  const { totalRequests, authFailures } = peekSnapshot();
  if (totalRequests < MIN_REQUESTS_FOR_ANOMALY) return;
  if (authFailures > ANOMALY_AUTH_FAILURES) {
    throw new Error(`Auth failures ${authFailures} in current window exceeds threshold ${ANOMALY_AUTH_FAILURES}`);
  }
}

function checkTrafficSpike() {
  const { totalRequests } = peekSnapshot();
  if (totalRequests < MIN_REQUESTS_FOR_ANOMALY) return;
  if (totalRequests > ANOMALY_TRAFFIC_SPIKE) {
    throw new Error(`Request count ${totalRequests} in current window exceeds threshold ${ANOMALY_TRAFFIC_SPIKE}`);
  }
}

const RUNBOOKS = {
  db: {
    impact: "All API requests will fail — users cannot log in, load data, or submit anything.",
    causes: [
      "PostgreSQL connection pool exhausted (too many concurrent requests)",
      "Database server entered read-only / recovery mode (disk full or replica failover)",
      "PostgreSQL process crashed or was OOM-killed",
    ],
    steps: [
      "1. SSH into VPS: check PostgreSQL status → `systemctl status postgresql`",
      "2. Check DB logs → `journalctl -u postgresql -n 50`",
      "3. Check disk space → `df -h` (full disk forces PG read-only)",
      "4. Check pool stats → GET /pool-stats (requires admin JWT)",
      "5. If pool exhausted: restart app → `pm2 restart drms`",
      "6. If PG down: restart → `systemctl restart postgresql`",
    ],
  },
  tables: {
    impact: "API endpoints that touch missing tables will return 500 errors to users.",
    causes: [
      "Migration was partially applied or rolled back mid-way",
      "Table was accidentally dropped (DROP TABLE)",
      "Database was restored from an older backup missing recent migrations",
      "Schema was recreated without running all migration scripts",
    ],
    steps: [
      "1. Connect to DB → `psql -U $DB_USER -d $DB_NAME`",
      "2. List tables → `\\dt` — identify which are missing",
      "3. Check migration history → `SELECT * FROM schema_version ORDER BY version DESC;`",
      "4. Re-run missing migrations → `psql -U $DB_USER -d $DB_NAME -f backend/migrations/001_initial_schema.sql`",
      "5. Verify tables exist → `\\dt` again",
      "6. Restart app → `pm2 restart drms`",
    ],
  },
  email: {
    impact: "OTP delivery will fail — users cannot register, log in (without active session), or reset passwords.",
    causes: [
      "EMAIL_PASS was rotated (Gmail App Password expired or regenerated)",
      "EMAIL_USER / EMAIL_HOST env vars missing or wrong",
      "Gmail account security settings blocked the connection",
      "SMTP server is down or unreachable from VPS",
      "VPS outbound port 587/465 blocked by firewall",
    ],
    steps: [
      "1. Check env vars → `pm2 env drms | grep EMAIL`",
      "2. Verify Gmail App Password is still valid → myaccount.google.com → Security → App Passwords",
      "3. Test SMTP manually → `openssl s_client -connect smtp.gmail.com:465`",
      "4. If password rotated: update EMAIL_PASS in /opt/drms/backend/.env → `pm2 reload drms --update-env`",
      "5. Check VPS firewall → `ufw status` — ensure port 587/465 outbound is allowed",
    ],
  },
  storage: {
    impact: "File uploads (project proofs, certificates, photos) will fail. Existing files are unaffected.",
    causes: [
      "Disk usage reached 90%+ — no space left for new uploads",
      "Upload directory permissions changed (chmod/chown)",
      "Mount point unmounted or NFS/remote storage disconnected",
      "Disk failure or filesystem error (read-only remount)",
    ],
    steps: [
      "1. Check disk usage → `df -h` and `du -sh /opt/drms/uploads/*`",
      "2. If disk full: clean old logs → `journalctl --vacuum-size=500M`, remove temp files",
      "3. Check upload dir permissions → `ls -la /opt/drms/uploads`",
      "4. Fix permissions if needed → `chmod 755 /opt/drms/uploads && chown drms:drms /opt/drms/uploads`",
      "5. Check mount → `mount | grep uploads` (if using external storage)",
      "6. After fix: app recovers automatically within 60s — no restart needed",
    ],
  },
  error_rate: {
    impact: "High rate of 5xx responses — multiple users are hitting server errors on every request.",
    causes: [
      "Database query failing on a hot code path (e.g. missing column after botched migration)",
      "Unhandled exception in a route after a recent deploy",
      "Third-party service (SMTP, Cloudflare) throwing errors that propagate to the API",
      "Memory pressure causing process instability",
    ],
    steps: [
      "1. Check PM2 logs for stack traces → `pm2 logs drms --lines 100`",
      "2. Check health endpoint → `curl -s http://localhost:5000/health | jq .`",
      "3. If DB check failing → follow the [db] runbook",
      "4. If a recent deploy landed → roll back → `git checkout <prev-hash>` + `pm2 reload drms`",
      "5. Check memory → `pm2 monit` — if heap near limit, restart → `pm2 restart drms`",
    ],
  },
  latency: {
    impact: "API responses are slow — users experience timeouts or long waits on all pages.",
    causes: [
      "Slow database queries (missing index, table scan on large table)",
      "Connection pool near exhaustion — requests queuing for a slot",
      "Database server under high I/O or CPU load",
      "Network latency between app VM and DB VM increased",
    ],
    steps: [
      "1. Check pool stats → `curl -s -H 'Authorization: Bearer <token>' http://localhost:5000/pool-stats | jq .`",
      "2. If pool waiting > 0: check for long-running queries → `SELECT pid, query, now() - pg_stat_activity.query_start AS duration FROM pg_stat_activity WHERE state = 'active' ORDER BY duration DESC;`",
      "3. Check DB server load → SSH to drms-db: `top`, `iostat -x 1 5`",
      "4. If pool exhausted: restart app → `pm2 restart drms`",
      "5. Monitor after restart — alert resolves within 60s if latency returns to normal",
    ],
  },
  auth_failures: {
    impact: "Possible credential stuffing or brute-force attack on login/OTP endpoints.",
    causes: [
      "Automated login attempts (credential stuffing from leaked password lists)",
      "OTP brute-force attack against a specific account",
      "Misconfigured integration repeatedly hitting auth with wrong credentials",
      "Load test running against production accidentally",
    ],
    steps: [
      "1. Check auth logs → `pm2 logs drms --lines 100 | grep auth`",
      "2. Identify source IPs → check Nginx access log → `tail -n 200 /var/log/nginx/access.log | grep 401`",
      "3. If single IP: block with UFW → `ufw deny from <ip> to any`",
      "4. Check otp_attempts table for targeted accounts → `psql -U $DB_USER -d $DB_NAME -c 'SELECT identifier, attempt_count FROM otp_attempts ORDER BY attempt_count DESC LIMIT 10;'`",
      "5. If wide attack: consider temporarily tightening rate limits in Nginx",
    ],
  },
  traffic_spike: {
    impact: "Unusually high request volume — may degrade performance for all users or indicate a DDoS.",
    causes: [
      "Legitimate surge (assignment deadline, exam results released)",
      "Runaway scraper or misconfigured client in a retry loop",
      "DDoS or stress test pointed at production",
      "Viral link to the app shared externally",
    ],
    steps: [
      "1. Check Nginx access log for request distribution → `tail -n 500 /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -20`",
      "2. If one or few IPs dominate: block with UFW → `ufw deny from <ip>`",
      "3. Check PM2 and pool health → `pm2 status drms`, `curl -s http://localhost:5000/health | jq .`",
      "4. If legitimate spike: monitor — alert resolves when volume drops below threshold",
      "5. Consider enabling Cloudflare proxy (if not already) for rate-limiting and DDoS protection",
    ],
  },
};

function buildSummary(checkName, errorMessage) {
  const r = RUNBOOKS[checkName];
  if (!r) return errorMessage;
  return [
    `ERROR: ${errorMessage}`,
    ``,
    `IMPACT: ${r.impact}`,
    ``,
    `POSSIBLE CAUSES:`,
    ...r.causes.map((c) => `  • ${c}`),
    ``,
    `RECOVERY STEPS:`,
    ...r.steps,
  ].join("\n");
}

// minConsecutive: how many back-to-back failing cycles before Zenduty pages.
//   1 = page immediately (infrastructure — always broken, always actionable)
//   2 = page after 2 cycles (~2 min) — filters one-off transient anomalies
//
// traffic_spike is intentionally excluded: high volume with healthy error rate
// and latency is not actionable on its own. It is logged as a warning below
// instead of paging. If the spike is causing harm, error_rate or latency fires.
const CHECKS = [
  { name: "db",            fn: checkDatabase,     minConsecutive: 1 },
  { name: "tables",        fn: checkCoreTables,   minConsecutive: 1 },
  { name: "email",         fn: checkEmail,        minConsecutive: 1 },
  { name: "storage",       fn: checkStorage,      minConsecutive: 1 },
  { name: "error_rate",    fn: checkErrorRate,    minConsecutive: 2 },
  { name: "latency",       fn: checkLatency,      minConsecutive: 2 },
  { name: "auth_failures", fn: checkAuthFailures, minConsecutive: 2 },
];

async function postZenduty(message, alertType, entityId, summary) {
  const url = process.env.ZENDUTY_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        alert_type: alertType,
        status: alertType === "info" ? "resolved" : "triggered",
        entity_id: entityId,
        summary,
      }),
    });
    logger.debug("health.zenduty.post", { entity_id: entityId, alert_type: alertType, "http.status": res.status });
  } catch (err) {
    logger.warn("health.zenduty.post.failed", { err, entity_id: entityId });
  }
}

export async function runHealthChecks() {
  for (const { name, fn, minConsecutive } of CHECKS) {
    try {
      await fn();
      consecutiveFailures.set(name, 0);
      logger.debug("health.check.ok", { "health.check": name });
      if (firingAlerts.get(name)) {
        firingAlerts.set(name, false);
        logger.info("health.check.recovered", { "health.check": name });
        await postZenduty(`DRMS [${name}] recovered`, "info", `drms-${name}`, `${name} check recovered`);
      }
    } catch (err) {
      const count = (consecutiveFailures.get(name) || 0) + 1;
      consecutiveFailures.set(name, count);

      if (count < minConsecutive) {
        // Transient — warn locally so it shows in logs, but don't page yet.
        // If it persists to the next cycle, it will fire.
        logger.warn("health.check.warning", {
          "health.check": name,
          "health.consecutive": count,
          "health.fires_at": minConsecutive,
          err,
        });
      } else if (!firingAlerts.get(name)) {
        // Condition has persisted long enough — page.
        firingAlerts.set(name, true);
        logger.error("health.check.failed", {
          "health.check": name,
          "health.consecutive": count,
          err,
        });
        await postZenduty(
          `DRMS [${name}] failed: ${err.message}`,
          "critical",
          `drms-${name}`,
          buildSummary(name, err.message),
        );
      }
    }
  }

  // Traffic spike: log-only — high volume with healthy error rate / latency is
  // not independently actionable. If the spike is causing harm, error_rate or
  // latency will fire instead.
  try {
    checkTrafficSpike();
  } catch (err) {
    logger.warn("health.anomaly.traffic_spike", { message: err.message });
  }
}

export function getHealthStatus() {
  const status = {};
  for (const { name } of CHECKS) {
    status[name] = firingAlerts.get(name) ? "failing" : "ok";
  }
  return status;
}

export function startHealthMonitor() {
  // One-time startup check: JWT_SECRET must be set or auth silently breaks
  if (!process.env.JWT_SECRET) {
    logger.error("health.startup.jwt_secret_missing", {
      message: "JWT_SECRET is not set — token signing will fail",
    });
  }

  const interval = Number(process.env.HEALTH_CHECK_INTERVAL_MS) || 60_000;
  setInterval(() => {
    runHealthChecks().catch((err) => logger.error("health.monitor.error", { err }));
  }, interval);
  setTimeout(() => {
    runHealthChecks().catch((err) => logger.error("health.monitor.initial.error", { err }));
  }, 5_000);
  logger.info("Health monitor started", { "health.interval_ms": interval });
}
