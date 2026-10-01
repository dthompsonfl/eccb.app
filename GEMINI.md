# GEMINI.md - Project Context & Master Reference

## 1. Project Identity
**Name:** Emerald Coast Community Band (ECCB) Management Platform
**Purpose:** A production-grade, domain-driven platform integrating a public CMS-driven website, secure member portal, digital music library, and band operations management.
**Tech Stack:** Next.js 16 (App Router), React 19, MariaDB, Prisma, Better Auth, Redis, Local Disk or S3-Compatible (Free Tier).
**Lifecycle:** Designed for 5-10 years of operation.

---

## 2. Documentation Index (Source of Truth)
This project is strictly defined by the following documentation files. **All code generation and architectural decisions must align with these specifications.**

| File | Category | Description |
|------|----------|-------------|
| **`PLATFORM_OVERVIEW.md`** | Executive | High-level summary, feature requirements, success metrics, cost analysis, and "What's Next". |
| **`ARCHITECTURE.md`** | Technical | System architecture, domain boundaries, tech stack rationale, security model, and performance strategy. |
| **`VISUAL_ARCHITECTURE.md`** | Diagrams | ASCII diagrams of client/edge layers, data flow, caching strategy, and deployment pipeline. |
| **`DATABASE_SCHEMA.md`** | Data | Complete Prisma schema (30+ models), relationships, indexes, and migration strategy. |
| **`PERMISSIONS.md`** | Security | Role-Based Access Control (RBAC) system, 7 roles, permission matrix, and implementation patterns. |
| **`IMPLEMENTATION_GUIDE.md`** | Roadmap | Step-by-step 13-phase development guide, setup instructions, and core service code examples. |
| **`Design.md`** | UI/UX | Design system, color palette, typography, GSAP motion choreography, and component layouts. |
| **`AGENTS.md`** | Standards | Code style guidelines, import conventions, TypeScript usage, testing rules, and git workflow. |
| **`README.md`** | Entry | Project entry point, quick start, and navigation. |
| **`docs/SECURITY.md`** | Security | Security protocols, headers, CSRF, rate limiting, and audit tools. |
| **`docs/ACCESSIBILITY.md`** | A11y | WCAG 2.1 AA standards, testing procedures, and component guidelines. |
| **`docs/SMART_UPLOAD.md`** (deprecated; see `docs/smart-upload/SMART_UPLOAD_SYSTEM_GUIDE.md`) | Feature | AI-powered music PDF metadata extraction architecture and flow. |
| **`docs/stand-*.md`** | Feature | Digital Music Stand architecture, rendering, annotations, and user guide. |
| **`docs/DATABASE_SETUP_ARCHITECTURE.md`** | DB | Database setup wizard and repair system architecture. |
| **System Settings** | Config | All application settings are database-driven via `/admin/settings` UI; env falls back only if db values missing. |
| **`SYSTEM_SETTINGS.md`** (implied)| Config | All application settings are database-driven via `/admin/settings` UI; env falls back only if db values missing. |

---

## 3. System Architecture
**Reference:** `ARCHITECTURE.md`, `VISUAL_ARCHITECTURE.md`

### Core Domains (Bounded Contexts)
1.  **Public Content:** CMS-driven pages (Home, About, Events). No auth required.
2.  **Auth & Identity:** User accounts, sessions, RBAC.
3.  **Member Management:** Profiles, instruments, sections, lifecycle status.
4.  **Music Library (Core):** Digital catalog, PDF storage, part assignments, secure downloads.
5.  **Events & Rehearsals:** Scheduling, attendance tracking, setlists.
6.  **Communications:** Announcements, notifications, email.
7.  **Administration:** System config, audit logs, reporting.

### Key Technical Decisions
*   **Server Components:** Default for data fetching and rendering.
*   **Server Actions:** Used for all mutations (form submissions, data updates).
*   **Middleware:** Handles auth checks and route protection.
*   **Edge Caching:** Aggressive caching for public content; Redis for session/hot data.
*   **File Storage:** Local Disk or S3-Compatible (Free Tier) for secure music access.

---

## 4. Data Model
**Reference:** `DATABASE_SCHEMA.md`

### Schema Highlights
*   **ORM:** Prisma
*   **Primary Keys:** CUID strings (`id String @id @default(cuid())`).
*   **Audit:** All tables include `createdAt`, `updatedAt`. Most have `deletedAt` (soft delete).
*   **Music Library Structure:**
    *   `MusicPiece`: Metadata (Composer, Title, Difficulty).
    *   `MusicPart`: Specific instrument part (e.g., "Flute 1").
    *   `MusicFile`: Physical file reference (Storage key).
    *   `MusicAssignment`: Link between Member and MusicPiece/Part.

---

## 5. Security & Permissions
**Reference:** `PERMISSIONS.md`

### RBAC Hierarchy
`SUPER_ADMIN` > `ADMIN` > `DIRECTOR` > `SECTION_LEADER` > `LIBRARIAN` > `MUSICIAN` > `PUBLIC`

### Implementation Pattern
Permissions follow the `resource.action.scope` format (e.g., `music.view.assigned`).
*   **Check:** `requirePermission('music.create')` in Server Actions.
*   **Scope:** Users can often view `all`, `section`, or `own` data depending on role.
*   **Audit:** All mutations must be logged via `auditLog()` service.

---

## 6. Design System & UI
**Reference:** `Design.md`

### Visual Identity
*   **Theme:** Cinematic coastal elegance.
*   **Colors:**
    *   Primary: `#0f766e` (Teal)
    *   Accent: `#f59e0b` (Amber)
    *   Neutral: `#1f2937` (Dark Gray)
*   **Typography:** `Oswald` (Headings), `Inter` (Body).

### Motion (GSAP)
*   **Engine:** GSAP ScrollTrigger.
*   **Easing:** Custom variables (e.g., `--ease-dramatic`).
*   **Performance:** Use `will-change` and GPU acceleration.

---

## 7. Coding Standards
**Reference:** `AGENTS.md`

### Rules
1.  **Imports:** Absolute imports (`@/lib/...`). Group: React -> External -> Internal.
2.  **TypeScript:** Strict mode enabled. Use `interface` for objects. No `any`.
3.  **Styling:** Tailwind CSS with `cn()` utility for class merging.
4.  **Components:** PascalCase. Place in `src/components`.
5.  **Error Handling:** Use Zod for validation. Fail gracefully with Error Boundaries.

### Directory Structure
```
src/
├── app/                 # Next.js App Router
├── components/          # React components (ui, forms, layouts)
├── lib/                 # Utilities
│   ├── auth/            # Better Auth & Permissions
│   ├── db/              # Prisma client
│   ├── services/        # Business logic (Music, Members, etc.)
│   └── utils/           # Helpers
├── types/               # TypeScript definitions
└── prisma/              # Schema and seeds
```

---

## 8. Implementation Roadmap
**Reference:** `IMPLEMENTATION_GUIDE.md`

### Current Status: Phase 0 (Architecture Complete)

### Immediate Next Steps (Phase 1-3)
1.  **Foundation:** Init Next.js 16, TS, Tailwind.
2.  **Database:** Setup MariaDB, Prisma, apply schema.
3.  **Auth:** Install Better Auth, implement RBAC middleware.

### Core Feature Priority
1.  **Music Library:** This is the "Star" feature. Prioritize file upload/download and metadata management.
2.  **Member Portal:** Dashboard for musicians to access music.

---

## 10. System Settings Architecture
**Reference:** Settings are configured via `/admin/settings` browser UI

### Database-First Configuration Pattern
All application settings follow a **database-first** architecture:

1. **Primary Source:** `SystemSetting` table (managed via `/admin/settings` UI)
2. **Fallback:** `.env` environment variables (for first-startup or missing values only)
3. **Cache:** Redis with 5-minute TTL for performance

### Implementation Details
- **Settings Code:** `src/lib/stand/settings.ts` exports `getStandSettings()`, `updateStandSettings()`
- **Admin Form:** `src/components/admin/settings/music-stand-settings-form.tsx`
- **Allowlist:** `STAND_SETTING_KEYS` defines which settings can be updated via UI
- **Alias Handling:** Some settings have aliases (e.g., `maxFileSizeMb` ↔ `maxPdfSizeBytes`)

### Available Music Stand Settings
- `stand.enabled` — Master kill-switch (disabled = 404 for all stand pages)
- `stand.realtimeMode` — `"polling"` or `"websocket"`
- `stand.websocketEnabled` — Allow WebSocket upgrade
- `stand.websocketPort` — Port for standalone Socket.IO worker (default: 3005)
- `stand.pollingIntervalMs` — Fallback interval (default: 5000)
- `stand.practiceTrackingEnabled` — practice timer toggle (implemented)
- `stand.offlineEnabled`, `stand.allowOfflineSync` — **NOT IMPLEMENTED**: no
  working PWA (`public/sw.js` self-unregisters, manifest is
  `display: browser`), so nothing is cached for offline use
- `stand.audioSyncEnabled` — **NOT IMPLEMENTED**: no audio link editor
- `stand.accessPolicy` — `"any_member"` or `"rsvp_only"`
- Limit settings: `maxAnnotationsPerPage`, `maxStrokeDataBytes`, `maxPdfSizeBytes`, `maxFileSizeMb`
- `stand.maintenanceMessage` — Message shown when stand is disabled

### Adding New Settings
1. Add field to `StandGlobalSettings` interface in `src/lib/stand/settings.ts`
2. Add to `STAND_SETTING_KEYS` allowlist (controls what can be updated via UI)
3. Set default in `DEFAULT_SETTINGS` object (fallback to env if needed)
4. Add Zod schema field to form schema in `music-stand-settings-form.tsx`
5. Add form field UI in the component (auto-persisted to database on submit)
6. Settings are automatically cached and available via `getStandSettings()`

---

## 11. Agent Instructions (Updated)
---

## 10. System Settings Architecture
**Reference:** Settings are configured via `/admin/settings` browser UI

### Database-First Configuration Pattern
All application settings follow a **database-first** architecture:

1. **Primary Source:** `SystemSetting` table (managed via `/admin/settings` UI)
2. **Fallback:** `.env` environment variables (for first-startup or missing values only)
3. **Cache:** Redis with 5-minute TTL for performance

### Implementation Details
- **Settings Code:** `src/lib/stand/settings.ts` exports `getStandSettings()`, `updateStandSettings()`
- **Admin Form:** `src/components/admin/settings/music-stand-settings-form.tsx`
- **Allowlist:** `STAND_SETTING_KEYS` defines which settings can be updated via UI
- **Alias Handling:** Some settings have aliases (e.g., `maxFileSizeMb` ↔ `maxPdfSizeBytes`)

### Available Music Stand Settings
- `stand.enabled` — Master kill-switch (disabled = 404 for all stand pages)
- `stand.realtimeMode` — `"polling"` or `"websocket"`
- `stand.websocketEnabled` — Allow WebSocket upgrade
- `stand.websocketPort` — Port for standalone Socket.IO worker (default: 3005)
- `stand.pollingIntervalMs` — Fallback interval (default: 5000)
- `stand.practiceTrackingEnabled` — practice timer toggle (implemented)
- `stand.offlineEnabled`, `stand.allowOfflineSync` — **NOT IMPLEMENTED**: no
  working PWA (`public/sw.js` self-unregisters, manifest is
  `display: browser`), so nothing is cached for offline use
- `stand.audioSyncEnabled` — **NOT IMPLEMENTED**: no audio link editor
- `stand.accessPolicy` — `"any_member"` or `"rsvp_only"`
- Limit settings: `maxAnnotationsPerPage`, `maxStrokeDataBytes`, `maxPdfSizeBytes`, `maxFileSizeMb`
- `stand.maintenanceMessage` — Message shown when stand is disabled

### Adding New Settings
1. Add field to `StandGlobalSettings` interface in `src/lib/stand/settings.ts`
2. Add to `STAND_SETTING_KEYS` allowlist (controls what can be updated via UI)
3. Set default in `DEFAULT_SETTINGS` object (fallback to env if needed)
4. Add Zod schema field to form schema in `music-stand-settings-form.tsx`
5. Add form field UI in the component (auto-persisted to database on submit)
6. Settings are automatically cached and available via `getStandSettings()`
