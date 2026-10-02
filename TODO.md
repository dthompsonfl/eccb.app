# Project Roadmap & TODOs

This document tracks the implementation progress of the Emerald Coast Community Band (ECCB) Management Platform. It is derived from the `IMPLEMENTATION_GUIDE.md` and the Master Feature List.

**Target Stack:** Next.js 16, React 19, MariaDB, Prisma, Better Auth, Redis, Local Disk or S3-Compatible (Free Tier).

> **Status (last updated via production-readiness sweep):** 82 pages, 81 API routes compiled and passing 2424 unit tests. Items below reflect the verified state of the codebase.

---

  - [X] **Project Initialization**
  - [X] Initialize Next.js 16 App Router project (`npx create-next-app@latest`)
  - [X] Use the Next Devtools MCP Tool to ensure the app is next.js 16 compliant. (proxy.ts replaces middleware.ts)
  - [X] Configure TypeScript (`tsconfig.json` strict mode)
  - [X] Setup Tailwind CSS v4 & Shadcn UI
  - [X] Configure ESLint & Prettier
  - [X] Setup directory structure (`/app`, `/components`, `/lib`, `/types`)

  - [X] **Database & Caching**
  - [X] Provision MariaDB database (Local/Supabase/Neon)
  - [X] Initialize Prisma ORM
  - [X] Apply complete schema from `DATABASE_SCHEMA.md`
  - [X] Run initial migration
  - [X] Seed database with default Roles, Instruments, and Sections
  - [X] Provision Redis instance (Upstash/Local)
  - [X] Configure Redis client in `lib/redis.ts`

  - [X] **File Storage**
  - [X] Ensure Storage is configured for the project using a Locally Hosted Method
  - [X] Configure CORS and Storage Policies
  - [X] Implement `lib/storage.ts` service (Upload, Delete, Signed URLs)

  - [X] **Better Auth Integration**
  - [X] Install & configure Better Auth
  - [X] Implement Email/Password login
  - [X] Implement OAuth (Google) — conditional on `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars
  - [X] Implement Magic Links
  - [X] Implement Password Reset & Recovery flows
  - [X] Configure Session Management (Redis-backed)

  - [X] **RBAC Implementation**
  - [X] Implement `requirePermission()` middleware/hook
  - [X] Create Permission Matrix (Super Admin, Admin, Director, Section Leader, Librarian, Musician, Public)
  - [X] Implement `proxy.ts` for route protection
  - [X] Create "Forbidden" (403) page

  - [X] **Security Hardening**
  - [X] Implement Rate Limiting (API & Auth routes)
  - [X] Configure CSRF protection
  - [X] Set up Audit Logging service (`lib/audit.ts`)

  - [X] **Music Catalog Management**
  - [X] Create `MusicPiece` CRUD (Create, Read, Update, Delete)
  - [X] Implement metadata fields (Composer, Arranger, Difficulty, Duration, Genre)
  - [X] Implement "Library Tools" (Filtering, Sorting, Availability detection)

  - [X] **File Management**
  - [X] Implement File Upload UI (Drag & drop, progress bar)
  - [X] Handle PDF uploads (Scores & Parts)
  - [X] Handle Audio uploads (MP3/WAV)
  - [X] Implement secure file download (Signed URLs)
  - [X] **Feature:** Watermarking — `src/lib/music/watermark.ts`
    - Default-secure: a missing row, a null flag, or a failed lookup all resolve to watermarked.
    - Only an explicit, audited admin action (`PATCH /api/admin/music/watermark`, reason required) disables it.
    - Applied strictly AFTER authorization on both delivery routes; an unauthorised request still receives zero bytes.
    - [ ] S3 driver: see the note under Offline Access — not watermarked.
    - [ ] Non-PDF parts (e.g. MP3) pass through unwatermarked; tracked via download counts in the licensing report instead.

  - [X] **Assignments & Distribution**
  - [X] Create Assignment UI (Assign to Section, Member, or Event)
  - [X] Build "My Music" Dashboard for Musicians
  - [X] Implement "What music do I need?" logic
  - [X] Offline Access (Service Worker/PWA caching for PDFs)
    - Implemented in `public/sw.js` (policy: `src/lib/stand/offline.ts`, unit-tested).
    - Score caches are namespaced per user and purged on sign-out; API responses are never cached.
    - Gates on `stand.offlineEnabled` / `stand.allowOfflineSync` in Admin → Stand settings.
    - [ ] S3 driver: delivery 302s to a presigned URL, so bytes are never buffered. Offline scoring is therefore LOCAL-driver only.

  - [X] **Member Profiles**
  - [X] Create Member CRUD
  - [X] Link `User` accounts to `Member` profiles
  - [X] Implement Profile Fields (Instruments, Contact, Emergency Info)
  - [X] Profile Photo upload

  - [X] **Membership Lifecycle**
  - [X] Implement Status tracking (Active, Inactive, Alumni, Leave of Absence)
  - [X] Build New Member Onboarding Workflow
  - [X] Build Audition Status tracking (Pending/Accepted/Declined)

  - [X] **Self-Service Portal**
  - [X] "My Profile" page for members to update own info
  - [X] Availability preferences

---

  - [X] **Event Management**
  - [X] Create Event CRUD (Concerts, Rehearsals)
  - [X] Implement Venue management
  - [X] Call times & Dress code fields
  - [ ] **Feature:** Concert Program Order management — not yet implemented

  - [X] **Rehearsal Logistics**
  - [X] Link Music pieces to Rehearsals (Repertoire list)
  - [X] Rehearsal Notes (Section-specific & General)

  - [X] **Attendance System**
  - [X] Build Check-in Interface (Kiosk mode or Section Leader view)
  - [X] Track Status (Present, Absent, Excused, Late)
  - [X] Generate Attendance Reports & Analytics
  - [X] Member participation analytics

  - [X] **Announcements System**
  - [X] Create Announcement CRUD
  - [X] Implement Targeting (Global, Role-based, Section-based)
  - [X] Dashboard "News Feed" widget

  - [X] **Notifications**
  - [X] Setup Email Provider (Resend/AWS SES)
  - [X] Implement In-App Notification Center
  - [X] Trigger emails for: New Music, Schedule Changes, Urgent Alerts
  - [ ] **Feature:** Push Notifications (PWA) — `sw.js` scaffolded but push subscription not yet wired up

**Goal:** Replace legacy Vite app with Next.js CMS.

  - [X] **CMS Architecture**
  - [X] Implement `Page` and `PageVersion` logic
  - [X] Build Block-based Page Builder (Hero, Text, Image, List)
  - [X] Rich Text Editor (Markdown + WYSIWYG)

  - [X] **Public Pages (Migration)**
  - [X] Home Page (Hero, Announcements)
  - [X] About the Band
  - [X] Directors / Staff Bios
  - [X] Concert & Event Listings
  - [X] Contact Page (Form + Email trigger)
  - [X] Join / Auditions Page

  - [X] **Media Gallery**
  - [X] Photo/Video Gallery — public route `src/app/(public)/gallery`, admin route `src/app/(admin)/admin/gallery`

  - [X] **SEO & Publishing**
  - [X] Metadata management per page
  - [X] Draft / Preview / Publish workflow
  - [ ] Scheduled publishing — not yet implemented

---

  - [X] **Admin Dashboard**
  - [X] High-level stats (Membership, Attendance, Library)
  - [X] Recent Activity / Audit Log viewer

  - [X] **Configuration**
  - [X] Manage Instruments & Sections
  - [X] Manage Roles & Permissions
  - [X] System Settings (Global config)

  - [X] **Search & Discovery**
  - [X] Implement Global Search (Command Palette)
  - [X] Advanced Music Search
  - [X] Member Search

  - [X] **Reporting**
  - [X] Music Inventory Export (CSV/PDF)
  - [X] Member Rosters (PDF)
  - [ ] Concert Programs generation — not yet implemented
  - [ ] Licensing Compliance Reports — not yet implemented

  - [ ] **Accessibility**
  - [ ] WCAG 2.1 AA Audit — documented in `docs/ACCESSIBILITY.md`, not yet formally verified
  - [ ] Keyboard Navigation verification
  - [ ] Screen Reader testing
  - [ ] Large-print support for music parts (where applicable)

  - [X] **UI Polish**
  - [X] Dark Mode implementation
  - [X] Mobile responsiveness check
  - [X] Loading states (Skeletons) & Error Boundaries
  - [X] GSAP Animations (Ported from legacy site)

  - [X] **Testing**
  - [X] Unit Tests (Vitest) — 188 test files, 3169 tests passing (verified 2026-10-01)
  - [X] E2E Tests (Playwright) — 5 spec files, 12 assertions: route-load smoke tests
  - [ ] Real workflow E2E — not yet written. No browser test currently exercises
    login -> open a score, drawing on the stand, annotation save/reload, zoom or
    orientation persistence, stylus input, finger-vs-pen, pedal page turns, the
    two-page spread, half-page view, smart navigation, offline operation, or
    setlists during a performance. The stand specs assert only that a route
    renders without a server error.
  - [ ] Load Testing (Music download concurrency) — not yet performed

  - [ ] **Migration**
  - [ ] Export data from any legacy systems
  - [ ] Import content into new CMS
  - [ ] Setup Redirects for old URLs

- [ ] **Infrastructure**
  - [ ] Configure Production Database (Backups, Point-in-time recovery)
  - [ ] Configure CDN / Edge Caching
  - [ ] Domain DNS setup
  - [ ] SSL Certificates

---

## 🔮 Future / Nice-to-Have (Feature 17)
**Goal:** Post-MVP enhancements.

- [X] Music playback with synced score — Digital Music Stand implemented with PDF viewer, annotations, real-time sync
- [X] Markup/annotation tools for PDF parts — implemented in Digital Music Stand
- [X] Practice tracking logs for musicians — implemented in Digital Music Stand
- [ ] Donor management system (Integrate into Users/Members system. Need to ensure we have a clear understanding of the donor management requirements, DB schema, UI/UX design, stripe integration, reporting requirements, legality and compliance requirements, etc.)
- [ ] Ticketing platform integration (legality and compliance requirements, DB schema, UI/UX design, stripe integration, reporting requirements, etc.)
- [ ] Member dues management (Integrate into Users/Members system using stripe. Need to ensure we have a clear understanding of the member dues management requirements, DB schema, UI/UX design, stripe integration, reporting requirements, legality and compliance requirements, etc. Need to develop complete implementation plan using the stripe MCP to ensure proper implementation.)
