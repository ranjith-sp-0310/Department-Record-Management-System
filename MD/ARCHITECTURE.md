# DRMS — Architecture Document

---

## VM Inventory

| # | Role | Hostname | OS | Key Ports | Notes |
|---|------|----------|----|-----------|-------|
| 1 | App + Web Server | `drms-prod` | Ubuntu 22.04 LTS | 80, 443 (public), 5000 (internal) | Runs Nginx, Node.js (PM2), hosts uploads |
| 2 | Database Server | `drms-db` | Ubuntu 22.04 LTS | 5432 (internal only) | PostgreSQL 15, firewalled — no public access |

> Fill in actual IPs, RAM, CPU, and disk specs from your hosting provider before training.

---

## Network Flow

```
Internet
   │
   ▼
Nginx :443 (TLS termination)
   │
   ├─── GET /            →  /var/www/drms/frontend/dist  (static files)
   │
   └─── /api/*           →  Node.js :5000  (reverse proxy)
                               │
                               ├── PostgreSQL :5432  (internal)
                               │
                               ├── SMTP :587           (outbound — OTP email)
                               │
                               ├── Cloudflare Workers  (outbound — metrics flush every 60s)
                               │
                               └── Zenduty Webhook     (outbound — health alerts)

GET /health             →  Node.js :5000  (NOT proxied by Nginx — internal only)
```

**Firewall rules (expected):**

| Direction | Port | Source | Destination | Purpose |
|-----------|------|--------|-------------|---------|
| Inbound   | 443  | 0.0.0.0/0 | App VM | HTTPS traffic |
| Inbound   | 80   | 0.0.0.0/0 | App VM | HTTP → HTTPS redirect |
| Inbound   | 5432 | App VM only | DB VM | PostgreSQL |
| Outbound  | 587  | App VM | smtp.gmail.com | OTP email |
| Outbound  | 443  | App VM | Cloudflare, Zenduty | Metrics + alerts |

---

## Service Dependencies

```
┌─────────────────────────────────────────────────┐
│                   DRMS Backend                   │
│                  (Node.js / PM2)                 │
│                                                  │
│  ┌──────────┐   ┌──────────┐   ┌─────────────┐  │
│  │ Express  │   │ pg Pool  │   │   Multer    │  │
│  │  :5000   │   │ (max 20) │   │  (uploads)  │  │
│  └──────────┘   └────┬─────┘   └──────┬──────┘  │
└───────────────────────┼────────────────┼─────────┘
                        │                │
              ┌─────────▼──────┐   ┌─────▼──────────────┐
              │  PostgreSQL    │   │  FILE_STORAGE_PATH  │
              │  drms_db :5432 │   │  /var/www/drms/     │
              │  17 tables     │   │  uploads/           │
              └────────────────┘   └────────────────────┘

External:
  Nodemailer ──► Gmail SMTP :587        (OTP delivery — fire & forget)
  metricsBuffer ──► Cloudflare Worker   (metrics every 60s)
  healthMonitor ──► Zenduty Webhook     (alerts on failure/recovery)
```

### Core Tables

| Table | Purpose |
|-------|---------|
| `users` | All accounts (admin / staff / student) |
| `otp_verifications` | Pending OTP codes (5-min expiry) |
| `user_sessions` | 90-day persistent sessions |
| `projects` | Student project submissions + verification |
| `project_files` | File metadata (UUID filenames, MIME, size) |
| `achievements` | Student achievement records |
| `activity_types` | Lookup table for activity categories |
| `activity_coordinators` | Staff → activity type assignments |
| `events` | Department events |
| `faculty_participations` | Faculty training / workshops |
| `faculty_research` | Funded research projects |
| `faculty_consultancy` | Consultancy engagements |
| `staff_uploads_with_document` | Bulk upload audit log |
| `student_profiles` | Extended student profile data |
| `staff_announcements` | Announcements from staff |
| `otp_attempts` | OTP brute-force tracking |
| `hackathons` | Hackathon entries and progress |

### Key Processes (PM2, process name: `drms`)

| Process | Command | Auto-restart |
|---------|---------|--------------|
| Backend | `pm2 start ecosystem.config.cjs` | Yes |
| Health monitor | Runs inside backend process (setInterval) | N/A |
| Metrics flush | Runs inside backend process (setInterval, 60s) | N/A |
| Session cleanup | Runs inside backend process (setInterval, 1hr) | N/A |

---

## Technology Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Frontend | React + Vite + Tailwind CSS | Node 18+ |
| Backend | Node.js + Express | 18+ |
| Database | PostgreSQL | 15 |
| Web Server | Nginx | 1.24+ |
| Process Manager | PM2 | 5.x |
| Auth | JWT (short-lived) + Session tokens (90-day) | — |
| File Uploads | Multer + UUID filenames | — |
| Email | Nodemailer → Gmail SMTP | — |
| Metrics | Cloudflare Workers Analytics Engine | — |
| Alerting | Zenduty (generic webhook) | — |
