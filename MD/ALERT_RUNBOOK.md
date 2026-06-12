# DRMS — Alert Runbook

All alerts fire from the internal health monitor (runs every 60s inside the backend process) to Zenduty. Each alert resolves automatically when the check passes again.

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
    "storage": "ok"
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
    "storage": "ok"
  }
}
```
HTTP status will be `503` when any check is `"failing"`.
