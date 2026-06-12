# DRMS — Deployment SOP

---

## Prerequisites

- SSH access to `drms-prod`
- PM2 installed globally (`npm i -g pm2`)
- Node.js 18+ on the server
- PostgreSQL running on `drms-db`
- `.env` file at `/opt/drms/backend/.env` with all required variables set

---

## Deploy

### 1. Pull latest code

```bash
cd /opt/drms
git fetch origin
git pull origin main
```

### 2. Install backend dependencies

```bash
cd /opt/drms/backend
npm ci --omit=dev
```

### 3. Run pending migrations

```bash
# Check which migrations need to run — compare against what's in the DB
psql -U $DB_USER -d $DB_NAME -c "SELECT * FROM schema_version ORDER BY version;"

# Apply any missing migrations in order
psql -U $DB_USER -d $DB_NAME -f migrations/001_initial_schema.sql
psql -U $DB_USER -d $DB_NAME -f migrations/002_otp_attempts.sql
# ... continue in sequence up to the latest
```

### 4. Build frontend

```bash
cd /opt/drms/frontend
npm ci
npm run build
# Output goes to frontend/dist/
```

### 5. Copy frontend build to Nginx web root

```bash
rsync -av --delete /opt/drms/frontend/dist/ /var/www/drms/frontend/dist/
```

### 6. Reload backend (zero-downtime)

```bash
pm2 reload drms --update-env
```

> Use `reload` not `restart` — reload achieves zero-downtime by spawning a new process before killing the old one.

### 7. Verify (see Verification section below)

---

## Rollback

### Quick rollback — revert to previous commit

```bash
cd /opt/drms
git log --oneline -5          # find the last known-good commit hash
git checkout <commit-hash>
```

Then repeat steps 2, 4, 5, 6 from Deploy.

### Database rollback

Migrations are additive — there are no down scripts. If a migration needs to be undone:

```bash
# Connect to DB
psql -U $DB_USER -d $DB_NAME

# Manually reverse the migration (e.g., drop a new column)
ALTER TABLE <table> DROP COLUMN IF EXISTS <column>;

# Update schema_version if applicable
DELETE FROM schema_version WHERE version = '<version>';
```

> Always take a DB backup before rolling back schema changes (see DR Runbook).

### Emergency rollback — restore from backup

See **DR Runbook → Database Recovery**.

---

## Verification

### 1. Check process is running

```bash
pm2 status drms
# Expected: status = online, restarts = 0 (or unchanged from before deploy)
```

### 2. Hit the health endpoint

```bash
curl -s http://localhost:5000/health | jq .
# Expected:
# {
#   "status": "ok",
#   "checks": {
#     "db": "ok",
#     "tables": "ok",
#     "email": "ok",
#     "storage": "ok"
#   }
# }
```

> Any check showing `"failing"` needs immediate attention before declaring the deploy successful.

### 3. Check PM2 logs for errors

```bash
pm2 logs drms --lines 50
# Look for: ERROR, WARN, unhandledRejection, ECONNREFUSED
```

### 4. Smoke test key endpoints

```bash
# Auth endpoint reachable
curl -s -o /dev/null -w "%{http_code}" https://your-domain.com/api/auth/login \
  -X POST -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","password":"wrong"}'
# Expected: 401 (not 500)

# Frontend loads
curl -s -o /dev/null -w "%{http_code}" https://your-domain.com/
# Expected: 200
```

### 5. Confirm Nginx is serving the new frontend

```bash
# Check the build timestamp in the HTML
curl -s https://your-domain.com/ | grep -o 'index-[a-z0-9]*\.js'
# Should match the filename in /var/www/drms/frontend/dist/assets/
```

### 6. Monitor for 5 minutes

```bash
pm2 logs drms --lines 0
# Watch for any errors coming in from real traffic
```

---

## Environment Variable Changes

If `.env` was modified as part of the deploy:

```bash
pm2 reload drms --update-env
# The --update-env flag picks up new/changed env vars
```

To verify a variable was picked up:

```bash
pm2 env drms | grep <VARIABLE_NAME>
```
