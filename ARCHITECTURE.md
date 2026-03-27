# Department Record Management System — Architecture

---

## 1. System Overview

```mermaid
graph TB
    Browser["🌐 Browser / SPA"]

    subgraph Infra["Infrastructure"]
        Nginx["Nginx\nReverse Proxy\n(SSL termination, CORS headers)"]
    end

    subgraph Frontend["Frontend  —  React 18 + Vite"]
        Router["React Router v6\n(lazy-loaded pages)"]
        AuthCtx["AuthContext\n(JWT + session token)"]
        AxiosClient["axiosClient.js\n(auto-injects Bearer + x-session-token)"]
        Pages["Pages\nStudent / Staff / Admin / Public"]
        Components["Shared Components\n(UI, ProtectedRoute, Navbar)"]
    end

    subgraph Backend["Backend  —  Express 5 + Node 22 (ESM)"]
        Server["server.js\n(helmet, JSON, CORS, requestLogger)"]

        subgraph MW["Middleware"]
            ReqLog["requestLogger\n(correlation ID / ECS)"]
            Auth["requireAuth / optionalAuth\n(JWT or session token)"]
            RoleAuth["requireRole()\n(RBAC)"]
            Validate["validate(schema)\n(Joi)"]
        end

        subgraph Routes["Routes  /api/*"]
            AuthR["/auth"]
            ProjR["/projects"]
            AchR["/achievements"]
            HackR["/hackathons"]
            EventR["/events, /events-admin"]
            StaffR["/staff"]
            AdminR["/admin"]
            StudentPR["/student/profile"]
            FacultyR["/faculty-*"]
            StudentsR["/students"]
            UploadR["/data-uploads"]
            ExportR["/bulk-export"]
            AnnouncR["/announcements"]
            CoordR["/activity-coordinators"]
            FilesR["/files/:filename"]
        end

        subgraph Controllers["Controllers"]
            AuthC["authController"]
            ProjC["projectController"]
            AchC["achievementController"]
            HackC["hackathonController"]
            EventC["eventController"]
            StaffC["staffController"]
            AdminC["adminController"]
            StudProfC["studentProfileController"]
            FacC["faculty*Controller (×3)"]
            StudBatchC["addStudentsController"]
            UploadC["dataUploadController"]
            ExportC["bulkExportController"]
            AnnouncC["announcementController"]
            CoordC["activityCoordinatorController"]
        end

        subgraph Services["Services"]
            ReviewSvc["reviewService\n(approve / reject workflow)"]
        end

        subgraph Utils["Utils"]
            Logger["logger.js\n(Winston + ECS)"]
            TraceStore["traceStore.js\n(AsyncLocalStorage)"]
            TokenUtils["tokenUtils.js\n(JWT sign/verify)"]
            SessionUtils["sessionUtils.js\n(session CRUD)"]
            OTPGen["otpGenerator.js\n(crypto.randomInt)"]
            MailClient["mailClient.js\n(fire-and-forget wrapper)"]
            QueryBuilder["queryBuilder.js\n(dynamic SQL)"]
        end

        subgraph Config["Config"]
            DB["db.js\n(pg Pool, max 20/50)"]
            Mailer["mailer.js\n(nodemailer, dual-mode SMTP)"]
            Upload["upload.js\n(multer, 50 MB limit)"]
        end
    end

    subgraph Data["Data Layer"]
        Postgres[("PostgreSQL\ndrms_db")]
        FileStore[("File Storage\n/uploads  (local disk)")]
        SMTP["SMTP Server\n(Gmail or custom host)"]
    end

    Browser <-->|"HTTPS"| Nginx
    Nginx -->|"Static assets (dist/)"| Frontend
    Nginx -->|"Proxy  /api/*"| Server

    Router --> Pages
    Pages --> Components
    Pages --> AuthCtx
    Pages --> AxiosClient
    AxiosClient -->|"HTTP  /api/*"| Nginx

    Server --> ReqLog --> Auth --> RoleAuth --> Validate
    Validate --> Routes
    Routes --> Controllers
    Controllers --> Services
    Controllers --> Utils
    Services --> Utils
    Controllers --> Config
    Services --> Config
    Config --> Postgres
    Config --> FileStore
    MailClient -->|"detached Promise\n(never awaits)"| Mailer
    Mailer -->|"SMTP\n(async)"| SMTP
```

---

## 2. Authentication & Session Flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as Express API
    participant DB as PostgreSQL
    participant Email as SMTP (async)

    Note over B,Email: ── REGISTRATION ──
    B->>API: POST /api/auth/register {email, password, role}
    API->>DB: INSERT users (hashed password)
    API->>DB: INSERT otp_verifications (otp, expires_at)
    API-->>Email: enqueueMail(OTP) [fire-and-forget]
    API-->>B: 200 {message: "OTP sent"}

    B->>API: POST /api/auth/verify {email, otp}
    API->>DB: SELECT & DELETE otp_verifications
    API->>DB: UPDATE users SET is_verified=true
    API->>DB: INSERT user_sessions (session_token, 90 days)
    API-->>B: 200 {token: JWT, sessionToken, user}

    Note over B,Email: ── LOGIN ──
    B->>API: POST /api/auth/login {email, password}
    API->>DB: SELECT users (compare bcrypt hash)
    alt Unverified account
        API->>DB: INSERT otp_verifications
        API-->>Email: enqueueMail(OTP) [fire-and-forget]
        API-->>B: 200 {needsVerification: true}
    else Verified, existing session
        API->>DB: SELECT user_sessions (valid, not expired)
        API-->>B: 200 {token: JWT, sessionToken, user}
    else Verified, no session
        API->>DB: INSERT otp_verifications (login OTP)
        API-->>Email: enqueueMail(OTP) [fire-and-forget]
        API-->>B: 200 {message: "OTP sent"}
    end

    B->>API: POST /api/auth/login-verify {email, otp}
    API->>DB: Validate OTP, mark used
    API->>DB: INSERT user_sessions
    API-->>B: 200 {token: JWT, sessionToken, user}

    Note over B,Email: ── PROTECTED REQUEST ──
    B->>API: GET /api/... (Authorization: Bearer JWT)
    API->>API: requireAuth: verify JWT signature
    API->>DB: SELECT users WHERE id=sub (role check)
    API-->>B: 200 {data}

    Note over B,Email: ── SESSION REFRESH ──
    B->>API: GET /api/... (x-session-token: TOKEN)
    API->>DB: SELECT user_sessions WHERE token=TOKEN AND expires_at > NOW()
    API->>DB: UPDATE user_sessions SET expires_at=+90days
    API-->>B: 200 {data}

    Note over B,Email: ── LOGOUT ──
    B->>API: POST /api/auth/logout
    API->>DB: DELETE user_sessions WHERE user_id=...
    API-->>B: 200 {message: "Logged out"}

    Note over B,Email: ── PASSWORD RESET ──
    B->>API: POST /api/auth/forgot {email}
    API->>DB: INSERT otp_verifications (reset OTP)
    API-->>Email: enqueueMail(OTP) [fire-and-forget]
    API-->>B: 200 {generic message}
    B->>API: POST /api/auth/forgot-verify {email, otp}
    API->>DB: Validate OTP
    API-->>B: 200 {resetToken}
    B->>API: POST /api/auth/reset {resetToken, newPassword}
    API->>DB: UPDATE users SET password_hash
    API->>DB: DELETE all user_sessions (force re-login)
    API-->>B: 200 {message: "Password updated"}
```

---

## 3. Request Middleware Pipeline

```mermaid
flowchart LR
    REQ([Incoming\nHTTP Request])

    REQ --> helmet["helmet()\nSecurity headers"]
    helmet --> json["express.json()\nBody parsing"]
    json --> cors["CORS\n(dev only)"]
    cors --> reqlog["requestLogger\n① generate correlationId\n② store in AsyncLocalStorage\n③ log request start"]

    reqlog --> public{Public\nroute?}
    public -->|Yes| handler["Route Handler\n(no auth)"]
    public -->|No| auth

    subgraph auth["Auth Chain"]
        requireAuth["requireAuth()\nBearer JWT  or\nx-session-token"]
        requireRole["requireRole(['staff','admin'])\nRBAC check"]
        validate["validate(joiSchema)\nBody / query validation"]
        requireAuth --> requireRole --> validate
    end

    auth --> controller["Controller\nBusiness Logic"]
    controller --> db[("PostgreSQL\nPool Query")]
    controller --> service["Service\n(e.g. reviewService)"]
    service --> db
    controller --> mailclient["mailClient\nenqueueMail()\n(detached, no await)"]
    controller --> multer["upload middleware\n(multer, file validation)"]
    multer --> filestore[("File\nStorage")]

    controller --> res["HTTP Response\n{data, message, trace_id}"]
    res --> errhandler["Global Error Handler\n(maps errors → JSON\nincludes trace_id)"]
    errhandler --> RESP([Response\nto Client])

    style mailclient fill:#f9c,stroke:#c66
    style filestore fill:#cfc,stroke:#696
    style db fill:#cff,stroke:#699
```

---

## 4. Frontend Component Tree

```mermaid
graph TD
    main["main.jsx\n(React 18 createRoot)"]
    main --> App["app.jsx\n(BrowserRouter + lazy routes)"]
    App --> AuthProvider["AuthContext.Provider\n(user, token, sessionToken)"]
    AuthProvider --> Router

    subgraph Router["React Router v6"]
        direction TB
        Public["Public Routes\n/login  /register-*\n/forgot-password  /verify-otp"]
        Protected["ProtectedRoute\n(checks auth + role)"]
        Protected --> StudentPages
        Protected --> StaffPages
        Protected --> AdminPages
    end

    subgraph StudentPages["Student Pages"]
        SD["StudentDashboard"]
        SA["StudentsAchievements"]
        SP["StudentsProjectUpload"]
        SE["StudentsEventsReg"]
        SH["HackathonEntryandProgress"]
        SN["StudentNotifications"]
    end

    subgraph StaffPages["Staff Pages"]
        StD["StaffDashboard"]
        VA["VerifyAchievements"]
        VP["VerifyProjects"]
        VH["VerifyHackathonProgress"]
        EM["EventsManagement"]
        PM["ProjectsManagement"]
        AM["AchievementsManagement"]
        FP["FacultyParticipation"]
        FR["FacultyResearch"]
        FC["FacultyConsultancy"]
        SBU["StudentsBatchUpload"]
        BE["BulkExportPage"]
        RG["ReportGenerator"]
    end

    subgraph AdminPages["Admin Pages"]
        AD["AdminDashboard"]
        AUM["AdminUsersManagement"]
        ARL["AdminRoleUsersList"]
        ASC["AdminStaffCoordinators"]
    end

    subgraph SharedComponents["Shared Components"]
        Navbar
        ProtectedRoute
        SuccessModal
        ErrorMessage
        Toast
        InputField
        UploadDropzone
        StatusBadge
        DataTable["DataTable / DataRow"]
        EventCard
        NotificationsBell
    end

    subgraph APILayer["API Layer"]
        AxiosClient["axiosClient.js\nget / post / put / patch\ndelete / uploadFile\nauto-auth headers\n401 → redirect /login"]
    end

    StudentPages --> SharedComponents
    StaffPages --> SharedComponents
    AdminPages --> SharedComponents
    SharedComponents --> AxiosClient
    StudentPages --> AxiosClient
    StaffPages --> AxiosClient
    AdminPages --> AxiosClient
    AxiosClient -->|"HTTP /api/*"| BackendAPI["Backend API\nlocalhost:5000 / Nginx proxy"]
```

---

## 5. Review / Approval Workflow

```mermaid
sequenceDiagram
    participant Staff as Staff / Admin
    participant API as Express API
    participant ReviewSvc as reviewService.js
    participant DB as PostgreSQL
    participant Email as SMTP (async)

    Staff->>API: POST /api/staff/projects/:id/approve\n{comment}
    API->>API: requireAuth + requireRole(['staff','admin'])
    API->>API: validate(reviewSchema)
    API->>ReviewSvc: reviewProject(id, staffId, 'approve', comment)
    ReviewSvc->>DB: BEGIN transaction
    ReviewSvc->>DB: UPDATE projects SET status='approved'
    ReviewSvc->>DB: SELECT creator email
    ReviewSvc-->>Email: enqueueMail(approval notification)\n[fire-and-forget, try/catch]
    ReviewSvc->>DB: COMMIT
    ReviewSvc-->>API: {message: "Project approved"}
    API-->>Staff: 200 {message: "Project approved"}

    Note over Staff,Email: Same flow for reject / achievements
```

---

## 6. File Upload & Retrieval

```mermaid
sequenceDiagram
    participant B as Browser
    participant API as Express API
    participant Multer as multer middleware
    participant FS as File Storage (/uploads)
    participant DB as PostgreSQL

    Note over B,DB: ── UPLOAD ──
    B->>API: POST /api/projects  (multipart/form-data)\nfields: srs_document, files (ZIP)
    API->>Multer: validate MIME type, size ≤ 50 MB
    Multer->>FS: write UUID-named file
    Multer-->>API: req.files [{filename, path, mimetype}]
    API->>DB: INSERT projects (files: JSONB [{uuid, originalname}])
    API-->>B: 201 {project, message}

    Note over B,DB: ── DOWNLOAD ──
    B->>API: GET /api/files/:filename?token=JWT
    API->>API: verify token (JWT or session)
    API->>FS: stream file
    API-->>B: 200  Content-Disposition: attachment
```

---

## 7. Database Schema Map

```mermaid
erDiagram
    users {
        uuid id PK
        text email
        text password_hash
        text role
        bool is_verified
        jsonb profile_details
        timestamp created_at
    }
    otp_verifications {
        uuid id PK
        text email FK
        text otp_code
        timestamp expires_at
    }
    user_sessions {
        uuid id PK
        uuid user_id FK
        text token
        timestamp expires_at
        jsonb device_info
    }
    projects {
        uuid id PK
        uuid created_by FK
        text title
        text status
        text verification_status
        jsonb files
        text academic_year
        timestamp created_at
    }
    achievements {
        uuid id PK
        uuid user_id FK
        text title
        text issuer
        bool verified
        jsonb files
        date date_of_award
    }
    events {
        uuid id PK
        uuid created_by FK
        text title
        text description
        date event_date
        jsonb attachments
    }
    hackathons {
        uuid id PK
        uuid team_lead_id FK
        text title
        text status
        timestamp created_at
    }
    hackathon_progress {
        uuid id PK
        uuid hackathon_id FK
        text update_text
        text status
        timestamp created_at
    }
    faculty_participations {
        uuid id PK
        uuid user_id FK
        text activity_name
        text role
        text proof_file
    }
    faculty_research {
        uuid id PK
        uuid user_id FK
        text title
        text journal
        text proof_file
    }
    faculty_consultancy {
        uuid id PK
        uuid user_id FK
        text client_name
        text proof_file
    }
    activity_types {
        uuid id PK
        text name
        text category
    }
    activity_coordinators {
        uuid id PK
        uuid user_id FK
        uuid activity_type_id FK
    }

    users ||--o{ otp_verifications : "verifies via"
    users ||--o{ user_sessions : "has sessions"
    users ||--o{ projects : "creates"
    users ||--o{ achievements : "earns"
    users ||--o{ hackathons : "leads"
    users ||--o{ faculty_participations : "records"
    users ||--o{ faculty_research : "records"
    users ||--o{ faculty_consultancy : "records"
    users ||--o{ activity_coordinators : "assigned as"
    hackathons ||--o{ hackathon_progress : "tracks"
    activity_types ||--o{ activity_coordinators : "managed by"
```

---

## 8. Infrastructure & Deployment

```mermaid
graph TB
    subgraph Client["Client"]
        Browser["Browser"]
    end

    subgraph Server["Production Server (VPS / VM)"]
        Nginx["Nginx\n:443 SSL\n— HTTPS → HTTP redirect\n— /api/* → proxy :5000\n— /* → serve dist/"]
        Node["Node.js :5000\nExpress backend\n(PM2 or systemd)"]
        PG[("PostgreSQL :5432\ndrms_db")]
        Files[("Local Disk\n/var/www/drms/uploads")]
    end

    subgraph Email["External"]
        SMTP["SMTP\n(Gmail / custom)"]
    end

    subgraph CI["Jenkins CI/CD"]
        J1["1. Checkout"]
        J2["2. npm ci (parallel backend + frontend)"]
        J3["3. vitest (backend tests + coverage)"]
        J4["4. vite build (frontend dist)"]
        J5["5. SCP dist → server"]
        J6["6. SSH: restart Node + reload Nginx"]
        J1 --> J2 --> J3 --> J4 --> J5 --> J6
    end

    Browser <-->|"HTTPS :443"| Nginx
    Nginx <-->|"HTTP :5000"| Node
    Node <-->|"pg Pool"| PG
    Node <-->|"fs read/write"| Files
    Node -.->|"SMTP async"| SMTP
    Nginx -->|"static files"| Files

    style SMTP fill:#f9c,stroke:#c66
    style CI fill:#ffe,stroke:#aa0
```

---

## 9. Async Mail (Fire-and-Forget) Detail

```mermaid
flowchart LR
    Controller["Controller\n(request cycle)"]
    enqueueMail["mailClient.enqueueMail()\nvoid — returns immediately"]
    sendMail["mailer.sendMail()\nnodemailer transport"]
    SMTP["SMTP Server"]
    Logger["logger.error()\n(ECS log on failure)"]

    Controller -->|"synchronous call"| enqueueMail
    Controller -->|"continues immediately"| Response["HTTP Response\n(not blocked)"]

    enqueueMail -->|"detached Promise\n(no await)"| sendMail
    sendMail -->|"SMTP handshake"| SMTP
    sendMail -->|".catch(err)"| Logger

    style Response fill:#cfc,stroke:#696
    style Logger fill:#fcc,stroke:#c66
    style SMTP fill:#ccf,stroke:#669
```
