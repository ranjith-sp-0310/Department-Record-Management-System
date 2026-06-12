# DRMS — Disaster Recovery Runbook

---

## Service Recovery

### Backend process down (PM2)

**Symptoms:** All API calls return connection refused. Nginx logs show upstream error.

```bash
# Check status
pm2 status drms

# Restart
pm2 restart drms

# If PM2 itself is not running
pm2 resurrect       # restore last saved process list
# or
pm2 start /opt/drms/backend/ecosystem.config.cjs

# Verify
pm2 status drms
curl -s http://localhost:5000/health | jq '.status'
```

---

### Nginx down

**Symptoms:** Site unreachable, connection refused on port 443.

```bash
systemctl status nginx
systemctl start nginx

# Test config before starting if it recently changed
nginx -t
systemctl reload nginx
```

---

### Backend crashes on startup (boot loop)

**Symptoms:** PM2 shows high restart count, status flips between `online` and `errored`.

```bash
pm2 logs drms --lines 50
# Common causes:
#   - DB_PASS wrong → ECONNREFUSED on pool connect
#   - JWT_SECRET missing → startup warning (non-fatal but auth broken)
#   - FILE_STORAGE_PATH invalid → hard exit in production
#   - DB_STATEMENT_TIMEOUT_MS non-numeric → pool error on connect

# Check env vars
pm2 env drms | grep -E "DB_|JWT_|FILE_|NODE_ENV"

# Fix .env then
pm2 reload drms --update-env
```

---

## VM Recovery

### App VM unresponsive

1. Force restart via hosting provider console (VPS control panel → Reboot)
2. On boot, confirm services started automatically:
   ```bash
   systemctl status nginx
   pm2 status drms
   ```
3. If PM2 did not auto-start:
   ```bash
   pm2 resurrect
   # or
   pm2 start /opt/drms/backend/ecosystem.config.cjs
   pm2 save
   ```
4. If Nginx did not auto-start:
   ```bash
   systemctl enable nginx
   systemctl start nginx
   ```
5. Run health check: `curl -s http://localhost:5000/health | jq .`

### Ensuring services start on boot

```bash
# PM2 — generate and enable startup script
pm2 startup
# Run the command it outputs, then:
pm2 save

# Nginx
systemctl enable nginx

# PostgreSQL
systemctl enable postgresql
```

---

## Database Recovery

> Complete this section with your team during the next training session.
> The outline below covers the key areas to document.

### Pre-requisites (to complete)

- [ ] Backup schedule documented (frequency, retention, storage location)
- [ ] Backup restore tested at least once in a non-production environment
- [ ] DB credentials stored in a secure location accessible without the VM

---

### Taking a manual backup

```bash
# Full database dump
pg_dump -U $DB_USER -d $DB_NAME -Fc \
  -f /var/backups/drms/drms_$(date +%Y%m%d_%H%M%S).dump

# Verify the dump is readable
pg_restore --list /var/backups/drms/drms_<timestamp>.dump | head -20
```

---

### Restoring from backup

```bash
# 1. Stop the backend to prevent writes during restore
pm2 stop drms

# 2. Drop and recreate the database (DESTRUCTIVE — confirm first)
psql -U postgres -c "DROP DATABASE drms_db;"
psql -U postgres -c "CREATE DATABASE drms_db OWNER $DB_USER;"

# 3. Restore
pg_restore -U $DB_USER -d $DB_NAME /var/backups/drms/drms_<timestamp>.dump

# 4. Verify key tables
psql -U $DB_USER -d $DB_NAME -c "SELECT COUNT(*) FROM users;"
psql -U $DB_USER -d $DB_NAME -c "\dt"

# 5. Restart backend
pm2 start drms

# 6. Run health check
curl -s http://localhost:5000/health | jq .
```

---

### Point-in-time recovery (WAL archiving)

> Document here once WAL archiving / continuous backup is configured.

---

### Data loss assessment

After a restore, verify data completeness:

```bash
psql -U $DB_USER -d $DB_NAME <<EOF
SELECT 'users'              AS tbl, COUNT(*) FROM users
UNION ALL
SELECT 'projects',                  COUNT(*) FROM projects
UNION ALL
SELECT 'achievements',              COUNT(*) FROM achievements
UNION ALL
SELECT 'project_files',             COUNT(*) FROM project_files
UNION ALL
SELECT 'user_sessions',             COUNT(*) FROM user_sessions
ORDER BY tbl;
EOF
```

Compare row counts against last known-good values to estimate data loss window.

---

### File storage recovery

Uploaded files (project proofs, certificates) are stored separately from the database at `FILE_STORAGE_PATH`.

> Document your file backup strategy here (rsync to secondary storage, S3 sync, etc.)

```bash
# Verify upload directory after VM recovery
ls -la $FILE_STORAGE_PATH | wc -l    # total file count
du -sh $FILE_STORAGE_PATH            # total size
```

Files referenced in the database but missing from disk will return 404 on download — they cannot be recovered without a file backup.

---

## Recovery Time Objectives (fill in)

| Scenario | Target RTO | Target RPO |
|----------|-----------|-----------|
| Backend process crash | < 2 min | 0 (no data loss) |
| App VM reboot | < 5 min | 0 |
| Database restore from backup | < 30 min | TBD (depends on backup schedule) |
| Full VM rebuild | TBD | TBD |
