# AGENTS.md

## Project Overview

The Emerald Coast Community Band (ECCB) Management Platform is a production-grade, domain-driven application integrating a public CMS-driven website, secure member portal, digital music library, and band operations management. Ensure you are generating completely secure, production-ready code. All code outputs must be fully functional and production-ready in an enterprise environment. All code MUST be 100% optimized to run as fast as possible and create minimal overhead. Latency must be below 100ms for all operations, and the application must use as little system resources as possible. Please ALWAYS use the Next-DevTools MCP Tool to ensure you are generating the most optimized code possible. Ensure you are using the latest Next.js 16 features and best practices. Security is critical. We must follow all GDPR, HIPAA, and PCI-DSS compliance standards. Ensure that this is fully compliant for all accessibility, local, state, federal, and international laws and regulations.

**Tech Stack:** Next.js 16 (App Router), React 19, MariaDB/MySQL, Prisma, Better Auth, Redis, BullMQ.
**Style:** Cinematic coastal elegance (Tailwind CSS + Radix UI + GSAP).

## Key Features

-   **Public Website:** CMS-driven pages with cinematic animations.
-   **Member Portal:** Secure dashboard for musicians (Music, Schedule, Profile).
-   **Digital Music Stand:** Interactive PDF viewer with annotations and real-time sync.
-   **Smart Upload:** OCR-Driven AI-powered music library ingestion.
-   **Operations:** Attendance tracking, event management, and role-based access control.

## Documentation Index (Knowledge Base)

Agents **MUST** consult these files for specific domain knowledge:

### Core Architecture
- **[PLATFORM_OVERVIEW.md](PLATFORM_OVERVIEW.md)**: High-level summary, features, and goals.
- **[ARCHITECTURE.md](ARCHITECTURE.md)**: System design, tech stack, and domain boundaries.
- **[VISUAL_ARCHITECTURE.md](VISUAL_ARCHITECTURE.md)**: System diagrams and data flow.
- **[DATABASE_SCHEMA.md](DATABASE_SCHEMA.md)**: Complete Prisma schema and data models.
- **[PERMISSIONS.md](PERMISSIONS.md)**: RBAC system, roles, and permission matrix.
- **[SECURITY.md](docs/SECURITY.md)**: Security protocols, headers, and audit tools.
- **[ACCESSIBILITY.md](docs/ACCESSIBILITY.md)**: WCAG 2.1 AA standards and testing.

### Setup & Deployment
- **[LOCAL_SETUP.md](LOCAL_SETUP.md)**: Development environment setup.
- **[DATABASE_SETUP_ARCHITECTURE.md](docs/DATABASE_SETUP_ARCHITECTURE.md)**: DB repair and setup wizard architecture.
- **[README.md](README.md)**: Entry point and quick start.
- **[CHANGELOG.md](CHANGELOG.md)**: Version history.

### Feature-Specific Documentation
- **[SMART_UPLOAD.md](docs/SMART_UPLOAD.md)** (deprecated; see [SMART_UPLOAD_SYSTEM_GUIDE.md](docs/smart-upload/SMART_UPLOAD_SYSTEM_GUIDE.md)): AI-powered music PDF metadata extraction.
- **[Smart Upload Agent Guide](docs/smart-upload/SMART_UPLOAD_AGENT_GUIDE.md)**: concise, agent‑oriented reference for the OCR‑first autonomous music upload/management system. Agents should consult this file when adding features or diagnosing issues in the smart‑upload pipeline.
- **[stand-developer-guide.md](docs/stand-developer-guide.md)**: Digital Music Stand architecture and API.
- **[stand-user-guide.md](docs/stand-user-guide.md)**: User manual for the Music Stand.
- **[stand-annotation-system.md](docs/stand-annotation-system.md)**: Canvas drawing and sync logic.
- **[stand-pdf-rendering.md](docs/stand-pdf-rendering.md)**: PDF.js integration and optimization.

## Build Commands

```bash
npm run dev          # Start dev server with HMR
npm run build        # Type-check + production build
npm run start        # Start production server
npm run lint         # Run ESLint
npm run test         # Run Vitest unit tests
npm run db:generate  # Generate Prisma client
```

## Code Style Guidelines

### Imports
-   Use absolute imports from `src/` (configured in tsconfig)
-   Group imports: React → external libraries → internal components/utils
-   Sort alphabetically within groups

### Formatting
-   2 spaces for indentation
-   Single quotes for strings
-   Trailing commas enabled
-   Print width: 100

### TypeScript
-   Enable `strict: true` in tsconfig
-   Prefer interfaces over type aliases for object shapes
-   Use explicit return types for exported functions
-   Avoid `any`; use `unknown` when type is uncertain

### Naming Conventions
-   Components: PascalCase (`Navigation`, `Hero`)
-   Hooks: camelCase with `use` prefix (`useAnimation`)
-   Utils/functions: camelCase (`cn`, `formatDate`)
-   CSS classes: kebab-case with Tailwind utility pattern
-   Constants: SCREAMING_SNAKE_CASE for config values

### Component Structure
1.  Imports (React, hooks, external, internal)
2.  Types/interfaces
3.  Helper functions
4.  Main component with sub-components defined below
5.  Default export

### Tailwind & CSS
-   Use `cn()` utility from `src/lib/utils.ts` for conditional classes
-   Follow design system colors: primary (#0f766e), primary-light (#5eead4), neutral-dark (#1f2937), accent (#f59e0b)
-   Apply animations via GSAP or Tailwind's `animate-*` classes
-   Use CSS custom properties for animation easing values

### Animation Guidelines (from design.md)
-   Easing library: `--ease-dramatic`, `--ease-smooth`, `--ease-bounce`, `--ease-expo-out`
-   Duration scale: micro (150ms), fast (300ms), normal (500ms), slow (800ms), cinematic (1200ms)
-   Use GSAP ScrollTrigger for scroll-driven animations
-   Include `prefers-reduced-motion` fallback
-   Performance: use `will-change: transform, opacity` and GPU acceleration

### Error Handling
-   Use React error boundaries for component failures
-   Validate form data with Zod schemas (see `react-hook-form` + `zod`)
-   Log errors with context; don't expose sensitive data
-   Provide user-friendly fallback UI for errors

### Testing
-   Use Vitest for unit tests
-   Place tests adjacent to source files (`*.test.tsx`)
-   Run single test: `npx vitest run filename.test.tsx`

### Linting
-   ESLint config extends: `recommended`, `reactHooks`, `reactRefresh`, `typescript-eslint`.
-   Fix auto-fixable issues: `npm run lint -- --fix`

### Git Workflow
-   Commit messages: imperative mood, max 72 chars
-   Feature branches: `feat/description`
-   Bug fixes: `fix/description`

## System Settings Architecture

### All Settings Are Database-Driven via Admin UI

**Location:** `/admin/settings` — Browser-based admin panel

**Data Flow:**
1. Admin updates settings via browser UI at `/admin/settings`
2. Settings are persisted to `SystemSetting` table in the database
3. Application code reads from database first, falls back to `.env` only if database values don't exist
4. Settings are cached in Redis for 5 minutes to minimize DB queries

**Key Settings Tables:**
- **Music Stand Settings** — Real-time mode, WebSocket port, polling interval, feature toggles, access policies
- **Email Settings** — SMTP configuration, sender addresses
- **Security Settings** — RBAC, password policies, audit logs
- **General Settings** — Band info, branding, feature flags

**Available Music Stand Settings:**
- `stand.enabled` — Master kill-switch (disabled = 404)
- `stand.realtimeMode` — `"polling"` or `"websocket"`
- `stand.websocketEnabled` — Allow WebSocket upgrade from polling
- `stand.websocketPort` — Port for standalone Socket.IO worker (default: 3005)
- `stand.pollingIntervalMs` — Fallback polling interval (default: 5000)
- `stand.offlineEnabled` — Enable offline caching
- `stand.allowOfflineSync` — Queue annotations offline
- `stand.practiceTrackingEnabled` — Show practice timer
- `stand.audioSyncEnabled` — Audio link editor
- `stand.accessPolicy` — `"any_member"` or `"rsvp_only"`
- Various limit and feature toggles

**Implementation:**
- Settings code: `src/lib/stand/settings.ts` — Exports `getStandSettings()`, `updateStandSettings()`
- Admin form: `src/components/admin/settings/music-stand-settings-form.tsx`
- Server helpers: `src/lib/stand/settings.ts` exports `STAND_SETTING_KEYS` allowlist

**For Agents:** When adding new settings:
1. Add field to `StandGlobalSettings` interface in `src/lib/stand/settings.ts`
2. Add to `STAND_SETTING_KEYS` allowlist
3. Set `DEFAULT_SETTINGS` default value (use env as fallback only)
4. Add Zod schema field + form field to music-stand-settings-form.tsx
5. Settings are automatically persisted and cached
