# DRMS — Alert Runbook

All alerts fire from the internal health monitor (runs every 60s inside the backend process) to Zenduty. Each alert resolves automatically when the check passes again.

### Alert firing policy

| Check type | Fires after | Rationale |
|-----------|-------------|-----------|
| `db`, `tables`, `email`, `storage` | 1 failing cycle (~1 min) | Infrastructure broken = always actionable immediately |
| `error_rate`, `latency`, `auth_failures` | 2 consecutive failing cycles (~2 min) | Filters one-off transient spikes; only pages for sustained conditions |
| `traffic_spike` | Never pages — logged only | High volume with healthy error rate / latency is not independently actionable; `error_rate` and `latency` cover the impact if the spike causes harm |

A check that fails once and then recovers before the second cycle produces a local `warn` log entry but no Zenduty alert.

---

## Alert → Action Mapping

### `DRMS [db] failed`

**Impact:** All API requests fail. Users cannot log in, load data, or submit anything.

**Immediate check:**
```bash
curl -s http://localhost:5000/health | jq '.checks.db'
pm2 logs drms --lines 20
```

**Actions in order:**

1. Check PostgreSQL is running:
   ```bash
   systemctl status postgresql
   ```

2. Check disk space (full disk forces PG into read-only):
   ```bash
   df -h
   ```
   If disk > 90% used → see storage runbook below.

3. Check PostgreSQL logs:
   ```bash
   journalctl -u postgresql -n 50
   ```

4. Check pool stats (requires admin JWT):
   ```bash
   curl -s -H "Authorization: Bearer <token>" http://localhost:5000/pool-stats | jq .
   ```
   If utilization > 90% → restart app: `pm2 restart drms`

5. If PostgreSQL is down:
   ```bash
   systemctl restart postgresql
   # Then wait 60s for health monitor to recover
   ```

**Resolves automatically** once DB is reachable and not in recovery mode.

---

### `DRMS [tables] failed`

**Impact:** API endpoints touching missing tables return 500 errors.

**Immediate check:**
```bash
psql -U $DB_USER -d $DB_NAME -c "\dt"
# Compare against the 17 expected tables in the architecture doc
```

**Actions in order:**

1. Identify which tables are missing:
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "
   SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public'
   ORDER BY table_name;"
   ```

2. Check migration history:
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "SELECT * FROM schema_version ORDER BY version;"
   ```

3. Re-run missing migrations in order:
   ```bash
   cd /opt/drms/backend
   psql -U $DB_USER -d $DB_NAME -f migrations/001_initial_schema.sql
   # Continue with any missing migration numbers
   ```

4. Verify tables now exist, then wait 60s for auto-recovery.

---

### `DRMS [email] failed`

**Impact:** OTP delivery fails. Users cannot register, log in (without an active 90-day session), or reset passwords. Users with active sessions are unaffected.

**Immediate check:**
```bash
pm2 env drms | grep EMAIL
```

**Actions in order:**

1. Verify env vars are set:
   ```bash
   pm2 env drms | grep -E "EMAIL_USER|EMAIL_PASS|EMAIL_HOST"
   ```

2. Test SMTP connectivity from the server:
   ```bash
   openssl s_client -connect smtp.gmail.com:465 -quiet
   # Should show certificate chain — if it hangs, port 465 is blocked
   ```

3. If Gmail App Password expired (most common cause):
   - Go to myaccount.google.com → Security → App Passwords
   - Generate a new password
   - Update `.env`:
     ```bash
     nano /opt/drms/backend/.env
     # Update EMAIL_PASS=<new_app_password>
     pm2 reload drms --update-env
     ```

4. Check VPS outbound firewall:
   ```bash
   ufw status
   # Ensure ports 587 and 465 outbound are allowed
   ```

**Resolves automatically** once SMTP `verify()` succeeds.

---

### `DRMS [storage] failed`

**Impact:** New file uploads fail (project proofs, certificates, event photos). Existing files and all other functionality are unaffected.

**Immediate check:**
```bash
df -h
ls -la $FILE_STORAGE_PATH
```

**Actions in order:**

1. Check disk usage:
   ```bash
   df -h /
   du -sh /opt/drms/uploads/
   ```

2. If disk > 90% full, free space:
   ```bash
   # Clean old PM2 logs
   pm2 flush
   # Vacuum system journal
   journalctl --vacuum-size=500M
   # Check for large temp files
   find /tmp -size +100M
   ```

3. Check upload directory permissions:
   ```bash
   ls -la /opt/drms/uploads/
   # Should be: drwxr-xr-x  drms drms
   ```
   Fix if needed:
   ```bash
   chmod 755 /opt/drms/uploads
   chown drms:drms /opt/drms/uploads
   ```

4. If using external/mounted storage, check mount:
   ```bash
   mount | grep uploads
   df -h /opt/drms/uploads
   ```

**Resolves automatically** within 60s after fix — no restart needed.

---

### `DRMS [error_rate] failed`

**Impact:** Multiple users are hitting server errors (5xx) on every request.

**Immediate check:**
```bash
pm2 logs drms --lines 100
curl -s http://localhost:5000/health | jq '.checks'
```

**Threshold:** Server error rate > 10% of requests in the current 60s window (override: `ANOMALY_ERROR_RATE_PCT`).

**Actions in order:**

1. Check logs for stack traces — identify the failing route.
2. Check all health checks — if `db` is also failing, follow the `[db]` runbook first.
3. If triggered after a deploy → roll back:
   ```bash
   cd /opt/drms && git log --oneline -5
   git checkout <last-good-hash>
   pm2 reload drms --update-env
   ```
4. Check memory pressure → `pm2 monit`. If heap near limit: `pm2 restart drms`.

**Resolves automatically** once error rate drops below threshold.

---

### `DRMS [latency] failed`

**Impact:** API responses are slow — users experience long waits or timeouts.

**Threshold:** p95 response time > 2000ms in the current 60s window (override: `ANOMALY_P95_LATENCY_MS`).

**Immediate check:**
```bash
curl -s http://localhost:5000/health | jq '.database.pool'
curl -s -H "Authorization: Bearer <token>" http://localhost:5000/pool-stats | jq .
```

**Actions in order:**

1. Check pool — if `waiting > 0` there are queued requests:
   ```bash
   psql -U $DB_USER -d $DB_NAME -c "
   SELECT pid, query, now() - query_start AS duration
   FROM pg_stat_activity WHERE state = 'active'
   ORDER BY duration DESC LIMIT 10;"
   ```
2. Kill long-running queries if found: `SELECT pg_terminate_backend(<pid>);`
3. Check DB server load: SSH to `drms-db` → `top`, `iostat -x 1 5`
4. If pool is exhausted: `pm2 restart drms`

**Resolves automatically** once p95 drops below threshold.

---

### `DRMS [auth_failures] failed`

**Impact:** Possible credential stuffing or brute-force attack on auth endpoints.

**Threshold:** More than 20 `401` responses from `/api/auth/*` in the current 60s window (override: `ANOMALY_AUTH_FAILURES`).

**Immediate check:**
```bash
tail -n 200 /var/log/nginx/access.log | grep " 401 "
```

**Actions in order:**

1. Identify attacking IPs:
   ```bash
   tail -n 500 /var/log/nginx/access.log | awk '$9==401{print $1}' | sort | uniq -c | sort -rn | head -10
   ```
2. Block top offenders:
   ```bash
   ufw deny from <ip> to any
   ```
3. Check if any account is being targeted:
   ```bash
   psql -U $DB_USER -d $DB_NAME -c \
     "SELECT identifier, attempt_count FROM otp_attempts ORDER BY attempt_count DESC LIMIT 10;"
   ```
4. If wide attack persists, tighten Nginx rate limits temporarily.

**Resolves automatically** once the failure count drops below threshold.

---

### Traffic spike (log-only — does not page)

High request volume alone is not independently actionable: if the app is handling it without elevated errors or latency, no on-call action is needed. This condition is logged as a local `warn` rather than a Zenduty alert.

**Threshold:** More than 500 requests in the current 60s window (override: `ANOMALY_TRAFFIC_SPIKE`).

**If you see `health.anomaly.traffic_spike` in logs and want to investigate:**
```bash
tail -n 1000 /var/log/nginx/access.log | awk '{print $1}' | sort | uniq -c | sort -rn | head -20
curl -s http://localhost:5000/health | jq '.database.pool'
```

1. If one or few IPs dominate → block: `ufw deny from <ip>`
2. If pool health is degraded → follow the `[latency]` runbook.
3. If legitimate surge (deadline, event) → no action needed.

> If the spike is actually causing harm, `error_rate` or `latency` will fire first — act on those instead.

---

## Zenduty Alert States

| `alert_type` | `status` | Meaning |
|-------------|----------|---------|
| `critical` | `triggered` | Check just failed — action required |
| `info` | `resolved` | Check recovered — no action needed |

Duplicate alerts are suppressed — you will only receive one `triggered` per failure event, and one `resolved` per recovery.

---

## Checking Overall Health Manually

```bash
curl -s http://localhost:5000/health | jq .
```

Expected response when all healthy:
```json
{
  "status": "ok",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "checks": {
    "db": "ok",
    "tables": "ok",
    "email": "ok",
    "storage": "ok",
    "error_rate": "ok",
    "latency": "ok",
    "auth_failures": "ok"
  },
  "database": {
    "latency": "2ms",
    "pool": {
      "total": 5,
      "idle": 5,
      "waiting": 0,
      "health": "healthy"
    }
  }
}
```

Response when degraded:
```json
{
  "status": "degraded",
  "checks": {
    "db": "ok",
    "tables": "ok",
    "email": "failing",
    "storage": "ok",
    "error_rate": "ok",
    "latency": "ok",
    "auth_failures": "failing"
  }
}
```
HTTP status will be `503` when any check is `"failing"`.
