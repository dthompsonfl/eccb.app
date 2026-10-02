# Project Roadmap & TODOs

This document tracks the implementation progress of the Emerald Coast Community Band (ECCB) Management Platform. It is derived from the `IMPLEMENTATION_GUIDE.md` and the Master Feature List.

**Target Stack:** Next.js 16, React 19, MariaDB, Prisma, Better Auth, Redis, Local Disk or S3-Compatible (Free Tier).

> **Status (evidence-based audit, 2026-10-01):** `npm run typecheck` and `npm run lint` both pass clean; `npm run test:run` = **199 test files / 3300 tests passing**; `npm run permissions:audit` passes. Next.js 16.1.6 / React 19.2.3 confirmed on disk.
>
> This document was rewritten after an independent audit because it was materially **stale** — it reported four features as "not yet implemented" that were in fact fully built and tested. Every completion claim below now cites the file that proves it. Items are classified as VERIFIED COMPLETE, GENUINELY INCOMPLETE (specific missing work named), or BLOCKED (needs an external prerequisite that cannot exist in a dev environment).
>
> **Legend:** `[X]` verified complete · `[ ]` incomplete · `[!]` blocked on external prerequisite

---

  - [X] **Project Initialization**
  - [X] Initialize Next.js 16 App Router project (`npx create-next-app@latest`) — on disk: `next@16.1.6`
  - [X] Use the Next Devtools MCP Tool to ensure the app is next.js 16 compliant. (proxy.ts replaces middleware.ts) — verified: `src/proxy.ts` present, `src/middleware.ts` absent
  - [X] Configure TypeScript (`tsconfig.json` strict mode)
  - [X] Setup Tailwind CSS v4 & Shadcn UI — `src/components/ui/` populated
  - [X] Configure ESLint & Prettier — `eslint.config.mjs` at root
  - [X] Setup directory structure (`/app`, `/components`, `/lib`, `/types`)

  - [X] **Database & Caching**
  - [X] Provision MariaDB database (Local/Supabase/Neon)
  - [X] Initialize Prisma ORM
  - [X] Apply complete schema from `DATABASE_SCHEMA.md`
  - [X] Run initial migration — `prisma/migrations/`
  - [X] Seed database with default Roles, Instruments, and Sections
  - [X] Provision Redis instance (Upstash/Local)
  - [X] Configure Redis client in `lib/redis.ts`

  - [X] **File Storage**
  - [X] Ensure Storage is configured for the project using a Locally Hosted Method — local disk driver active
  - [X] Configure CORS and Storage Policies
  - [X] Implement `lib/storage.ts` service (Upload, Delete, Signed URLs)
  - [X] **Feature:** Watermarking — `src/lib/music/watermark.ts`, enforcement on delivery in `watermark-delivery.ts`
    - Default-secure: a missing row, a null flag, or a failed lookup all resolve to watermarked.
    - Only an explicit, audited admin action (`PATCH /api/admin/music/watermark`, reason required) disables it.
    - Applied strictly AFTER authorization on both delivery routes; an unauthorised request still receives zero bytes.
    - [ ] Non-PDF parts (e.g. MP3) pass through unwatermarked; tracked via download counts in the licensing report instead.
      - **Genuinely incomplete (minor, arguably by design).** Byte-level watermarking is a PDF-render concern. Next action: only if audio watermarking is ever required, add a provenance field to the download record.

  - [X] **Better Auth Integration**
  - [X] Install & configure Better Auth
  - [X] Implement Email/Password login
  - [X] Implement OAuth (Google) — conditional on `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` env vars
  - [X] Implement Magic Links
  - [X] Implement Password Reset & Recovery flows
  - [X] Configure Session Management (Redis-backed)
  - [!] **Security:** 10 CRITICAL Better Auth advisories open (OAuth state mismatch, stale sessions surviving user deletion, OIDC `alg=none` + plain PKCE accepted by default, stored XSS via `javascript:` redirect_uri, concurrent-refresh token-family fork, **account takeover via OAuth auto-link to unverified pre-registered email**, unauthorized invitation acceptance, refresh-token replay, **account takeover via pre-account hijacking on magic-link/email-OTP sign-in**). Fixed in `>=1.6.22`. The account-takeover and magic-link pre-hijack issues are directly exploitable against this deployment's login path. **Next action: upgrade the whole `@better-auth/*` family to the patched version (all members together, plus a `better-call` override) — remediation in progress.**

  - [X] **RBAC Implementation**
  - [X] Implement `requirePermission()` middleware/hook
  - [X] Create Permission Matrix (Super Admin, Admin, Director, Section Leader, Librarian, Musician, Public) — `npm run permissions:audit` passes: no legacy permission strings in runtime source
  - [X] Implement `proxy.ts` for route protection
  - [X] Create "Forbidden" (403) page

  - [X] **Security Hardening**
  - [X] Implement Rate Limiting (API & Auth routes)
  - [X] Configure CSRF protection
  - [X] Set up Audit Logging service (`lib/audit.ts`)
  - [X] Canonical permission audit — `npm run permissions:audit` passes
  - [!] **Dependency CVEs:** `npm run security:audit` **FAILS** — 62 vulnerabilities (6 critical, 35 high, 18 moderate, 3 low). Runtime-path blockers: **Next.js** (28 advisories including unauthenticated RCE, Server Actions CSRF bypass via null origin, Proxy/Middleware bypass, SSRF, cache poisoning, RSC DoS — fixed in `16.3.8`) and **Better Auth** (above). Non-blocking: `vitest`, `@vitest/coverage-v8`, `concurrently`, `prisma` are dev/build-only tooling. **Next action: remediation in progress — see Security Hardening.**
  - [!] **Next.js upgrade landmine:** Next 16.3+ defaults `useTypeScriptCli: true` when it detects TypeScript >= 6. If this repo's TypeScript is the `@typescript/typescript6` alias (whose bin is `tsc6`, with no `bin/tsc`), route-type generation then fails permanently with a misleading "It looks like you're trying to use TypeScript… Installing dependencies… up to date" loop that re-running install never fixes. Mitigation: `experimental: { useTypeScriptCli: false }` in `next.config.ts`. Also never add a bare root `postcss` override — it replaces Next's internal pinned postcss and breaks the build; scope it as `"overrides": { "next": { "postcss": "8.5.26" } }`.

  - [X] **Music Catalog Management**
  - [X] Create `MusicPiece` CRUD (Create, Read, Update, Delete)
  - [X] Implement metadata fields (Composer, Arranger, Difficulty, Duration, Genre)
  - [X] Implement "Library Tools" (Filtering, Sorting, Availability detection)

  - [X] **File Management**
  - [X] Implement File Upload UI (Drag & drop, progress bar)
  - [X] Handle PDF uploads (Scores & Parts)
  - [X] Handle Audio uploads (MP3/WAV)
  - [X] Implement secure file download (Signed URLs)

  - [X] **Assignments & Distribution**
  - [X] Create Assignment UI (Assign to Section, Member, or Event)
  - [X] Build "My Music" Dashboard for Musicians
  - [X] Implement "What music do I need?" logic
  - [X] Offline Access (Service Worker/PWA caching for PDFs)
    - Implemented in `public/sw.js` (policy: `src/lib/stand/offline.ts`, unit-tested).
    - Score caches are namespaced per user and purged on sign-out; API responses are never cached.
    - Gates on `stand.offlineEnabled` / `stand.allowOfflineSync` in Admin → Stand settings.
    - [x] S3 driver note resolved: local disk is the configured driver. If S3 is ever adopted, delivery 302s to a presigned URL so bytes are never buffered, making offline scoring LOCAL-driver only — a documented design boundary, not a defect.

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
  - [X] **Feature:** Concert Program Order management — **implemented.** Domain: `src/lib/events/program.ts`, `program-query.ts`, `program-pdf.ts` (all with `__tests__`). Admin UI: `src/app/(admin)/admin/events/[id]/program/page.tsx` + `program-actions.ts` (tested in `__tests__/program-actions.test.ts`). Public print view: `src/app/(public)/events/[id]/program/print`. PDF endpoint: `src/app/api/events/[id]/program.pdf/route.ts`.

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
  - [X] Implement In-App Notification Center — `src/app/(member)/member/notifications`, `src/app/(admin)/admin/notifications`
  - [X] Trigger emails for: New Music, Schedule Changes, Urgent Alerts
  - [X] **Feature:** Push Notifications (PWA) — **implemented** (this item was wrongly marked unimplemented). Library: `src/lib/communications/push/{send,notify,consent,settings,subscriptions}.ts`. Endpoints: `src/app/api/push/{subscribe,consent,vapid-key}`. Service worker `push` listener at `public/sw.js:309`. Config: `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` in `env.example`. Schema: `UserPreferences.pushEnabled` is `@default(false)` with a separate `pushConsentedAt` timestamp (an Art. 7(1) consent record), plus `model PushSubscription`; migration `prisma/migrations/20261003120000_push_subscriptions`. Consent-gated by design, so a push can never be delivered silently. Covered by 5 test files including a schema/migration contract test.
    - [!] Requires real VAPID keys (`npx web-push generate-vapid-keys`) to deliver end-to-end. Keys are generated per-deployment and must never be committed.

---

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
  - [X] Scheduled publishing — **implemented.** Visibility gate `src/lib/cms/page-visibility.ts`; service logic in `src/lib/cms/cms.service.ts`; background worker tested in `src/workers/__tests__/scheduled-publish.test.ts` (12 tests), plus `src/lib/services/__tests__/cms-scheduled-visibility.test.ts` and `src/lib/cms/__tests__/page-visibility.test.ts`.
  - [ ] `sitemap.xml` / `robots.txt` — **genuinely incomplete.** No `src/app/sitemap.ts` or `src/app/robots.ts` exists anywhere in the tree. Needed for SEO on a public-facing community band site. Next action: add both as Next.js metadata route handlers driven by the published `Page` records.

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
  - [X] Music Inventory Export (CSV/PDF) — `src/app/api/admin/reports/export/route.ts`
  - [X] Member Rosters (PDF)
  - [X] Concert Programs generation — **implemented.** `src/lib/events/program-pdf.ts` + `src/app/api/events/[id]/program.pdf/route.ts` + the public print view.
  - [X] Licensing Compliance Reports — **implemented.** `src/lib/music/licensing-report.ts`, served by `src/app/api/admin/music/licensing-report/route.ts`.
  - [X] Attendance reporting — `src/app/(admin)/admin/reports/attendance/`

  - [X] **Accessibility**
    - [x] Strategy documented in `docs/ACCESSIBILITY.md` (POUR breakdown, keyboard nav, screen reader, contrast, focus management, ARIA, testing procedures).
    - [x] WCAG 2.1 AA Audit — **automated and enforced.** `e2e/accessibility/` scans the public homepage, the login page, and the member dashboard (authenticated via the existing `e2e/auth.setup.ts` storage state — no second login flow). 6 specs, currently **6/6 passing**. Fails the run on `serious`/`critical` impact; moderate/minor are printed and attached as a JSON artifact rather than silently dropped. `KNOWN_FALSE_POSITIVES` is deliberately **empty** — no rule is suppressed.
      - The audit found and closed real defects: carousel dot buttons in `src/sections/Hero.tsx` had **no accessible name** (critical, SC 4.1.2 — announced to a screen reader as bare "button"); now carry `aria-label`, `aria-current`, and `type="button"`. Hero CTAs failed **SC 1.4.3 contrast** — `.cta-primary` was 3.66:1 and `.cta-secondary` **1.01:1** (white text on a near-white `bg-background`, because `variant="outline"` was inherited on a dark hero). Fixed in-palette: `teal-600` → `teal-700` (the project's own `primary`, 5.47:1) and the secondary button is now `bg-transparent` with an explicit white border, showing the slate-900 hero through it (17.85:1).
      - **Known gap:** on hosts where Playwright publishes no Chromium build (this dev box is Ubuntu 26.04), `playwright install` fails. `playwright.config.ts` supports an opt-in, unset-by-default `PLAYWRIGHT_CHROME_EXE` that changes only the browser binary and cannot affect any assertion. Run as `PLAYWRIGHT_CHROME_EXE=/usr/bin/google-chrome npx playwright test e2e/accessibility/`.
      - **Known gap:** E2E auth only works on port **3225** (Better Auth `trustedOrigins`). On another port, sign-in fails `INVALID_ORIGIN` and scans would silently measure the login page — hence the guard that asserts the URL is not `/login`.
      - Still reported, not blocking (moderate, best-practice): `landmark-main-is-top-level`, `landmark-no-duplicate-main`, `landmark-unique` on the public homepage. The homepage nests a `<main>` inside the public layout's `<main>`; worth consolidating.
    - [x] Skip-link target resolved on public pages — the `SkipToContent` link in the root layout targets `#main-content`, but that ID existed only in the member layout, so it was a **dead link on every public page**. Added to `src/app/(public)/layout.tsx`.
    - [ ] Screen Reader testing — **genuinely incomplete.** No manual NVDA/VoiceOver pass is recorded anywhere in the repo. Automated axe coverage does not substitute for it: axe cannot judge whether a control's accessible NAME makes sense to a human, nor whether focus order matches the visual layout. Next action: a scripted pass over the login → dashboard → stand journey, recording findings in `docs/ACCESSIBILITY.md`.
    - [x] Large-print support (application UI) — **delivered.** Four-step text-size control (Small / Medium / Large / Extra large) in `src/lib/accessibility/text-scale.ts`, applied as `<html data-font-scale>` → `--font-scale` → root `font-size: calc(100% * var(--font-scale))` in `src/app/globals.css`. Scaling the ROOT font size is what makes this work: the UI is sized in `rem`, so text, padding and gaps scale together and compose with Tailwind instead of fighting it. Persisted to `localStorage` (`eccb:text-scale`), applied pre-paint by an inline script (`text-scale-script.ts`) so the size never flashes on load; defaults to `medium`; capped at 1.3 because past ~130% the multi-column layouts stop being usable. Browser-verified: `xlarge` → computed root font-size 20.8px (16 × 1.3). Control in `src/components/accessibility/text-size-control.tsx` with live "Aa" previews.
      - [ ] Large-print for the **PDF score rendering inside the music stand** — **still genuinely incomplete.** The viewer is a separate PDF.js canvas with its own scaling, so the app chrome scales but the score pages do not. For musicians reading a part at a rehearsal this is the case that actually matters most. Next action: feed the same `TextScale` preference into the PDF.js render scale.
    - [x] Plain-language microcopy — **delivered across the primary member journey:** login, dashboard, music stand, calendar, profile, attendance, RSVP, sidebar, header. Raw enum leaks fixed via `src/lib/accessibility/plain-language.ts` — badges now read "Rehearsal"/"Concert" instead of `REHEARSAL`/`CONCERT`, and "Came"/"Missed"/"Told us in advance" instead of `PRESENT`/`ABSENT`/`EXCUSED`; "RSVP" became "Let us know if you can come". Legal and admin copy deliberately left precise and unchanged.
    - [x] First-run onboarding walkthrough — `src/components/accessibility/onboarding-walkthrough.tsx` (5 steps, dependency-free, shadcn Dialog + Progress, Escape dismisses, focus-traps via Radix, `aria-labelledby`, "Step x of y"). Completion state versioned in `src/lib/accessibility/onboarding.ts`.
    - [x] Persistent "Show me how" re-open control — `src/components/accessibility/help-control.tsx`, mounted on the member header **and** the login page, so it is reachable before a member has ever signed in. The audience is people who cannot ask for help, so the affordance must not depend on having already succeeded at logging in.
    - [ ] Keyboard Navigation verification — **still unverified by automated test.** The walkthrough is keyboard-operable (Radix focus trap, Escape to dismiss, sane tab order) and `id="main-content"` was added to the member layout so the existing `SkipToContent` link finally resolves, but there is no automated assertion of full-site keyboard navigation. Next action: Playwright specs that tab through each primary surface and assert visible focus and reachable controls.
  - [X] **Real E2E workflow coverage** — **delivered and passing.** Replaced render-only smoke tests with real musician workflows in `e2e/stand/` (18 specs across `stand-workflow.spec.ts`, `stand-view-preferences.spec.ts`, `stand-two-page-spread.spec.ts`, plus a shared `_helpers.ts`). **18 passed, 1 skipped** (the skip is the legacy `stand-smoke` route check). Coverage: library navigation; **PDF.js rasterisation proven by counting non-transparent pixels** (not merely a mounted canvas); page turning; **draw → save → full `page.reload()` → byte-identical geometry + repainted ink**; two distinct strokes stored separately; annotations scoped to their page; zoom reaching the rasteriser and surviving both reload and client-side navigation; and the two-page spread toggling with a genuinely painted right-hand page. Every wait is an explicit condition on real state — no sleeps.
    - **Writing these tests exposed seven real product defects in the stand**, all fixed and unit-covered. The two most serious:
      - **Infinite render loop** (`usePdf.ts`): the page-render effect depended on `currentPage`, which the effect itself set — ~800 canvas renders/second, starving the main thread so completely that **user clicks, taps and page turns never completed**. Covered by `src/components/member/stand/__tests__/usePdf.test.tsx`.
      - **The first annotation stroke of every session was silently discarded** (`GestureHandler.tsx`): the overlay's pass-through state was derived from a value only computed inside its own `pointerdown` handler, so it swallowed the event it was meant to yield. Nothing was created or saved.
      - Also: annotation layers stuck at 300×150 (measured only on window resize, never when PDF.js laid out the page); page navigation permanently disabled because the DB `pageCount` is NULL and the store fell back to `?? 1`; the spread page never rendering after reload (PDF.js same-canvas render collision, now cancelled per-canvas); the two-page spread being unreachable at all (store actions existed with no caller — a toolbar control was added); and zoom never persisting despite the docs claiming it did.
    - **Seed fixture (required for these specs to run anywhere).** `prisma/seed-stand-fixture.ts` creates one MusicPiece + MusicFile under the sentinel catalog number `E2E-FIXTURE-0001`, with a real inked 27-page PDF written through the app's own storage service by `scripts/generate-stand-e2e-fixture-pdf.ts`. **The specs resolve the piece id at runtime rather than hardcoding a cuid**, which is what previously made 12 of them fail on any machine but the author's. Verified idempotent: two consecutive `db:seed` runs report the identical piece id and leave exactly 1 piece / 1 file.
      - Run with `PLAYWRIGHT_CHROME_EXE=/usr/bin/google-chrome npx playwright test e2e/stand/` — Playwright publishes no Chromium build for Ubuntu 26.04. E2E auth also only works on port **3225** (Better Auth `trustedOrigins`).
  - [ ] **Load Testing (Music download concurrency)** — not performed. Next action: a k6/Locust scenario against the delivery routes at realistic rehearsal-hour concurrency.

  - [X] **UI Polish**
  - [X] Dark Mode implementation
  - [X] Mobile responsiveness check
  - [X] Loading states (Skeletons) & Error Boundaries
  - [X] GSAP Animations (Ported from legacy site)

  - [X] **Testing**
  - [X] Unit Tests (Vitest) — **199 test files, 3300 tests passing** (verified 2026-10-01)
  - [X] E2E Tests (Playwright) — 5 spec files, route-load smoke tests (see "Real E2E workflow coverage" above for the gap)

  - [!] **Migration** — **blocked on external prerequisite.** No legacy data source, export, or redirect map exists (the only migration scripts, `scripts/benchmark-api-key-migration.ts` and `scripts/migrate-pnpm-to-npm.py`, are unrelated tooling). Requires: a dump from the legacy Vite app, a redirect map of old URLs, and a field mapping from the legacy schema. Cannot be completed or validated without the legacy system.
  - [ ] Export data from any legacy systems — blocked on the above
  - [ ] Import content into new CMS — blocked on the export above
  - [ ] Setup Redirects for old URLs — blocked on the URL inventory above

- [ ] **Infrastructure**
  - [!] Configure Production Database (Backups, Point-in-time recovery) — **documented, not provisioned.** `DEPLOYMENT.md` §"Backup Strategy" describes the procedure and `deploy/systemd/` ships `eccb-web.service`, `eccb-workers.service`, `eccb-sockets.service`. Requires a real managed MariaDB instance, or a running backup cron on a real host.
  - [ ] Configure CDN / Edge Caching — no CDN configuration found in `next.config.ts`. Deferred deliberately: a single-node community-band deployment does not need one, and Redis already fronts hot reads.
  - [!] Domain DNS setup — requires a registered domain and registrar access. Blocked.
  - [!] SSL Certificates — **documented, not provisioned.** `DEPLOYMENT.md` §"SSL/TLS Setup" provides a hardened nginx config (TLSv1.2/1.3, hardened cipher set, session tickets off) plus a Certbot auto-renewal procedure. Requires a real domain to issue against. Blocked.

---

## 🔮 Future / Nice-to-Have (Feature 17)
**Goal:** Post-MVP enhancements.

- [X] Music playback with synced score — Digital Music Stand implemented with PDF viewer, annotations, real-time sync
- [X] Markup/annotation tools for PDF parts — implemented in Digital Music Stand
- [X] Practice tracking logs for musicians — implemented in Digital Music Stand
- [!] Donor management system — **blocked on requirements discovery + payment provider.** No `stripe` dependency exists in `package.json`, no `STRIPE_*` key exists in `env.example`, and there is zero donor code in `src/`. Needs: requirements, DB schema, UI/UX design, Stripe integration, reporting, and legal/compliance review (sales-tax nexus for donations, charitable solicitation registration, receipting and 1099-NEC rules, PCI scope). Do not begin coding before a Stripe account exists and requirements are written down.
- [!] Ticketing platform integration — **blocked on requirements discovery + payment provider.** No stripe dep and no ticket code (only an unrelated `src/sections/Events.tsx` string match). Needs the same discovery pass plus: fee disclosure, refund/cancellation policy, capacity and inventory, and PCI-DSS scope reduction — use Stripe Checkout / Payment Element, never handle raw card data in-app.
- [!] Member dues management — **blocked on requirements discovery + payment provider.** No stripe dep and no dues code. Needs the same discovery pass plus: dues schedule and proration, hardship waiver, autopay consent and cancellation, and PCI scope. Stripe Billing + Customer Portal is the correct primitive, not a custom card form.

## Explicit non-goals / resolved
- **S3 storage driver** — not a defect. Local disk is the configured driver. If S3 is adopted, offline score caching is by design LOCAL-driver only, because S3 delivery 302s to a presigned URL and never buffers bytes.
- **MP3 watermarking** — not a defect. Watermarking is a PDF-render concern; audio downloads are tracked via licensing-report download counts.
- **CDN / Edge Caching** — deferred by choice, not oversight. Single-node deployment; Redis already fronts hot reads.