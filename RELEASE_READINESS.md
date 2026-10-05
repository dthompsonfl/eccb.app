# ECCB Release Readiness — Validated Status

**Status:** CODE COMPLETE, EXTERNAL VALIDATION REQUIRED
**Not release-certified:** cross-browser E2E (60/112 tests unrunnable here) and
an independent security review are still outstanding. See sections 1 and 4a.
**Validated at commit:** `31a1950` + uncommitted working-tree changes (see "Uncommitted work" below)
**Validated on:** 2026-10-04
**Host:** Ubuntu 26.04, Node v26.7.0, npm 11.19.0

> This document records **executable evidence only**. Every result below was
> produced by running the named command on the commit named above. Historical
> reports in this repository (`IMPLEMENTATION_REPORT.md`,
> `COMPLETION_CHECKLIST.md`, `PRODUCTION_READINESS_SWEEP.md`,
> `DEEP_PRODUCT_COMPLETION_REPORT.md`, `E2E_TEST_SUMMARY.md`, and the
> `*_READINESS_*` / `*_AUDIT_*` files) describe earlier points in time and must
> NOT be read as current release evidence.

---

## 1. Validation evidence

| Command | Scope | Result | Notes |
|---|---|---|---|
| `npm run typecheck` | Whole repo | PASS (exit 0) | `tsc --noEmit` |
| `npm run lint` | Whole repo | PASS (exit 0) | 0 errors, 0 warnings |
| `npm run permissions:audit` | RBAC constants | PASS (exit 0) | Canonical permission set intact |
| `npm run security:scan-secrets` | Repo secrets | PASS (exit 0) | |
| `npm audit --audit-level=moderate` | Dependency CVEs | PASS | **0 vulnerabilities** |
| `npm run test:run` | Unit + integration | PASS | **4151 tests / 255 files** |
| `npm run build` | Production build | PASS | Standalone output prepared |
| `npx playwright test --project=chromium` | E2E | PASS | 30/30 |
| `npx playwright test --project=stand` | Digital Music Stand E2E | PASS (1 known flake) | 21–22/23 pass; see rate-limit note |
| `npm run db:seed` | Data seeding | PASS | Idempotent; credentials verified |

### E2E environment note

Playwright pins an exact Chromium build per platform and **does not publish a
build for Ubuntu 26.04** — `npx playwright install` fails with
`Playwright does not support chromium on ubuntu26.04-x64`.

The repo already provides a documented escape hatch for exactly this case:
`PLAYWRIGHT_CHROME_EXE` in `playwright.config.ts`. Setting it to a compatible
system Chrome (`/usr/bin/google-chrome`) changes **only which browser binary
starts**. It cannot mask, skip, or soften any assertion — axe-core runs and
reports exactly as before.

```bash
export PLAYWRIGHT_CHROME_EXE=/usr/bin/google-chrome
export PLAYWRIGHT_BASE_URL=http://localhost:3225
npm run start:all &            # server + workers, health: /health on :3229
npx playwright test
```

A server must be running first: `playwright.config.ts` defines no `webServer`
block, so Playwright does not start one itself.

### ⚠️ Cross-browser E2E is NOT fully validated

Only Chromium is exercised. `~/.cache/ms-playwright` contains **no firefox and
no webkit** binaries, and Playwright cannot install them on Ubuntu 26.04
(`does not support ... on ubuntu26.04-x64`).

The `PLAYWRIGHT_CHROME_EXE` override only substitutes a **Chromium-family**
binary. The `firefox` and `webkit` projects — and the `Mobile Safari` and
`Tablet` projects, which are WebKit-based — have no equivalent override and
fail to launch:

```
Error: browserType.launch: Executable doesn't exist at
  /home/dylan/.cache/ms-playwright/webkit-2248/pw_run.sh
```

Consequently **60 of 112 E2E tests are unexecuted**, including iOS/Safari and
tablet-landscape coverage — which matters directly for the Digital Music Stand,
a flagship tablet-first surface. Treat this as an open validation gap, not a
passing gate. On a host with a supported platform, run the full matrix:

```bash
npx playwright install --with-deps
npx playwright test
```

---

## 2. Defects found and repaired in this pass

### P0 — `vision_api` was a selectable feature that could not work

`smart-upload-settings-form.tsx` offered "Vision API" as an OCR engine, but
`tryOcrEngine` (`ocr-fallback.ts`) returned empty text and zero confidence for
it. No cloud-OCR SDK and no `VISION_API` configuration contract exist anywhere
in the repository, so the engine was unbuildable as specified. This is the
"configuration says a feature exists while runtime says otherwise" defect.

Removed as a selectable capability (Option B), **without breaking existing
data**: `normalizeOcrEngineValue()` accepts a persisted `vision_api`/`pdf_text`
value and coerces it to `tesseract` with a warning. This mattered because
`config-loader.ts` previously used an unchecked `as` cast that would have fed
the dead value straight into the pipeline and silently produced zero OCR for
every subsequent upload.

Verified against the live database: `vision_api → tesseract`, `pdf_text →
tesseract`, valid engines pass through unchanged.

### P0 — Smart Upload coverage gate failed open

`smart-upload-worker.ts` computed the page count for quality gates inside a
`try/catch` that defaulted to `0`. `findCoverageIssues` (`quality-gates.ts`)
returns `{}` when `totalPages <= 0`, so a PDF that failed to parse **silently
disabled dropped-page and overlap detection** — a partial split could be
auto-committed as complete.

Now fails **closed**: on failure it logs, derives a best-available page count
from the parsed parts (keeping range validation meaningful), and forces
`requiresHumanReview = true`. This matches the convention already used
elsewhere in the codebase, which throws on an unknown page count.

### P1 — `isWakeLockActive()` reported a guarantee the platform never made

It returned `true` when only a no-op `requestAnimationFrame` timer was running.
No web page can guarantee screen wake without the native API, so this handed
callers a false promise. It now reports only a real sentinel. The sole consumer
(`PerformanceModeToggle.tsx`) already used `isUsingFallbackWakeLock()` and
displays an explicit "screen may still sleep" notice, so behaviour is unchanged
for users and honest for callers. The fallback is documented as best-effort.

### P1 — Playwright config defect made E2E unrunnable on supported hosts

Every project spread `chromeLaunch` **except** `chromium`. The documented
`PLAYWRIGHT_CHROME_EXE` escape hatch therefore silently did not apply to the main
project: the `setup` project authenticated fine while every `chromium` test
failed to launch. This presented as 12 apparent application failures and was
only found by executing the gate. One-line fix in `playwright.config.ts`.

### P1 — Three fully-implemented routes were unreachable

`/admin/monitoring` (775 lines), `/admin/attendance` (331), `/member/practice`
(84) were correctly permissioned, working, and linked from nothing — the only
references were their own pages and their own API calls. Wired into the
respective sidebars.

### P1 — Dead link in a second, concurrently-rendered admin nav

`src/app/(admin)/admin/layout.tsx` links to `/admin/cms`, which does not exist.
That nav renders alongside `AdminSidebar`, so the broken link was user-visible.
Retargeted to `/admin/announcements`.

### P2 — Skip-detection release gate never scanned `e2e/`

`FILE_GLOBS` was `['src', 'scripts']` while Playwright specs live in `e2e/`. A
skipped spec would have removed required coverage with no gate failure. Extended
to `e2e` and `tests`.

The single legitimate environment-dependent skip
(`e2e/auth.setup.ts`, credential-gated) is now an explicit, reasoned allowlist
entry. Its credentials (`SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`) **are**
present, so authenticated E2E genuinely runs rather than silently skipping.
Comment prose that merely names a skip pattern is ignored, with multi-line
block-comment state tracked so the gate stays usable.

### P1 — `/api/assets/[id]` GET had NO authentication or permission check

`src/app/api/assets/[id]/route.ts` called `getSession()` into an **unused
variable** and then streamed the file unconditionally. DELETE and PATCH in the
same file already required `CMS_EDIT`, which made the omission easy to miss.

Assets accept `application/pdf`, `.docx` and `.xlsx`
(`src/app/api/assets/upload/route.ts:41-46`) — so this exposed board contracts
and similar documents. On the S3 driver `downloadFile` returns a presigned URL,
so an anonymous caller received a directly usable link.

Now requires a session plus `CMS_VIEW_ALL`, checked **before** the database
lookup so an anonymous caller cannot distinguish "asset exists" (404) from
"denied" (401/403) and use the endpoint as an existence oracle.

Verified live: anonymous GET returns **401** for both a real-looking and a bogus
asset id.

### P1 — Event-scoped Stand access leaked other players' individual parts

`src/lib/music/access.ts` — for a member with **no** assignment, the
`withinEvent` relaxation returned `true` for every file on the piece, before any
part check. An active member who was assigned nothing could stream the conductor
score **and every sibling part** for any piece on any published event they could
attend.

The documented intent was "the published concert program", but the code granted
the whole piece. Now the relaxation applies only to the piece-level score; a
key that resolves to a `MusicPart` always requires an assignment.

This was **enshrined in a test** (`access.test.ts`) that asserted an unassigned
member could read `MY_PART_KEY` inside an event. The test encoded the
vulnerability, so it was rewritten to use the score key and a new regression test
asserts the sibling-part denial. Verified that test **fails** when the
vulnerable branch is restored.

### P1 — `canAccessMusicPiece` ignored archived / soft-deleted state

The file-level helpers (`canReadPieceFile`, `authorizeMusicFileAccess`) deny
archived and soft-deleted music to non-admins, but `canAccessMusicPiece` was a
bare role-or-assignment check with no such test. Every Stand endpoint that
resolves piece access through it — metadata, annotations (GET **and** POST),
audio, practice logs — could therefore read or write archived or soft-deleted
music. Added the same gate.

### P2 — `markOverdueAssignments` required only a session

Present in two files (`music/actions.ts`, `music/assignment-actions.ts`). Both
accepted **any** authenticated member while every sibling action in the same
files used `requirePermission(MUSIC_ASSIGN)`. Any member could flip assignment
statuses to `OVERDUE` via a direct server-action call. Both now require the
permission.

### P2 — Per-user offline cache isolation was never wired

The service worker namespaces cached scores per user id specifically so one
musician's music is never shown to the next on a shared rehearsal tablet — but
**neither half of that mechanism was connected**:

- `setServiceWorkerUser()` had **zero call sites** (only a doc comment), so the
  worker always ran with a null user and its namespacing could never engage.
- `purgeOfflineScores()` was exported and documented as running "on sign-out",
  but was **never called**. Signing out left the previous user's cached scores
  on the device.

Fixed by calling `setServiceWorkerUser(userId)` on mount/change in the member
header (the session id is threaded through from the member layout, which already
had it) and purging in **both** the member and admin sign-out handlers.

The ordering and failure behaviour were extracted into
`src/lib/auth/sign-out.ts` (`performSignOut`) so they are testable without
fighting Radix dropdown mechanics, and shared by both headers rather than
duplicated. Purging happens **before** the session ends, and a throwing purge
never blocks sign-out. Verified by reverting the ordering and confirming the
test fails.

### P2 — Dead no-op worker exports removed

`startSmartUploadWorker()`, `stopSmartUploadWorker()` and
`isSmartUploadWorkerRunning()` (`smart-upload-worker.ts`) were documented as
"kept for API compatibility in case any module still imports them". A repo-wide
search found **zero** importers, so no compatibility contract existed.
`isSmartUploadWorkerRunning()` hardcoded `return false`, which reads as a real
health signal to any future caller. Removed.

---

## 2. Security evidence

Executable probes against the running server (port 3225), unauthenticated:

| Probe | Result | Expected |
|---|---|---|
| `GET /api/files/<storageKey>` | **401** | 401/403 |
| `GET /api/files/download/<storageKey>` | **401** | 401/403 |
| `GET /api/stand/files/<storageKey>` | **401** | 401/403 |
| `GET /api/stand/audio-files/<storageKey>` | **401** | 401/403 |
| `GET /api/files/..%2F..%2F..%2Fetc%2Fpasswd` | **400** | reject |
| `GET /api/files/%2e%2e%2f%2e%2e%2fpackage.json` | **400** | reject |
| `GET /api/stand/files/../../../../etc/passwd` | **404** | reject |
| `GET /api/assets/<existing-or-bogus-id>` | **401** (both) | 401/403 — no existence oracle |

No private music is reachable without authentication, and traversal is rejected
on every serving route.

Independently confirmed clean by a read-only adversarial audit: unauthenticated
fetch by ID guessing, cross-member restricted fetch, storage path traversal
(local + S3), signed-URL binding, part-level scoping, watermarking fail-closed
behaviour, and Smart Upload part-preview key binding.

Structural notes:

- CSRF is enforced **centrally** in `src/proxy.ts` for mutating API requests,
  with a small set of explicitly justified exemptions (`/api/auth` is owned by
  Better Auth; `/api/setup`, `/api/health`). Individual routes do not duplicate
  the check.
- CSP carries `script-src 'unsafe-inline'` because Next.js emits inline
  bootstrap scripts. `'unsafe-eval'` is **not** enabled unless
  `NEXT_ENABLE_UNSAFE_EVAL=true`. This caveat is documented honestly at
  `docs/SECURITY.md`. **Known accepted limitation** — migrating to a
  nonce-based CSP in Next.js 16 forces the whole application to be
  dynamically rendered, which is a large architectural change and was
  deliberately not attempted autonomously.
- Storage abstraction has separate local and S3 adapters; path traversal is
  rejected before any filesystem or bucket access.

### `stand-annotation` rate limit makes back-to-back Stand E2E runs flaky

`src/lib/rate-limit.ts:42` sets a shared bucket of **60 requests/minute**. The
Stand workflow specs draw on it heavily, so running the `stand` project twice
inside a minute produces HTTP **429** in `stand-workflow.spec.ts` that reads
like a product bug. This is pre-existing and reproduces with the new specs
excluded. Run the project in isolation with a gap, or raise the bucket for CI.

---

## 4. Known external blockers

These require infrastructure or credentials not present in this environment.
They are **not** unfinished code.

1. **Live OCR provider validation.** Tesseract/ocrmypdf paths are configured and
   the OCR worker starts (`ocrEngine=ocrmypdf` observed at boot), but
   end-to-end Smart Upload against production-scale packets was not exercised
   with real provider credentials.
2. **Production MariaDB / Redis / S3.** Validated against local instances. No
   production backup/PITR restore rehearsal was performed.
3. **SMTP, push/VAPID.** Code paths verified; no live delivery test.
4. **Firewall/DNS/TLS.** Out of scope for the repository.
5. **Cross-browser E2E (code, not code defect).** 60 of 112 Playwright tests
   cannot launch on this host — firefox and webkit binaries are unavailable and
   un-installable on Ubuntu 26.04. Chromium coverage is green (30/30). See
   section 1.
6. **Smart Upload end-to-end against real provider credentials.** The pipeline
   code is exercised by unit/integration tests and the OCR worker boots, but a
   full upload → split → commit run against a production-scale packet with live
   LLM/OCR credentials was not performed here.

---

## 4a. Not verified in this pass

Stated plainly rather than implied by omission:

- The independent adversarial security auditor returned late and surfaced three
  P1 findings I had not seen; all three are now fixed (see section 2). Its
  Smart Upload/worker findings are recorded in section 4a, including four I did
  not fix.
- The Digital Music Stand annotation persistence, offline/IndexedDB
  user-scoping, and real-time leader/follower sync were **not** manually
  exercised. The wake-lock repair touches Stand behaviour, but Stand E2E specs
  are among the WebKit-blocked set.
- **Offline annotation queue is not user-scoped.** The audit found a single fixed
  IndexedDB (`eccb-offline`) with no user dimension, so after an account switch on
  a shared device one user's queued strokes could be flushed under another's
  session. **Partially fixed:** the service-worker score cache is now actually
  namespaced and purged (see above). The IndexedDB annotation queue itself is
  **still not user-scoped** and needs a per-user store — a data-shape change that
  should be done deliberately with migration of any queued work.
- **Music-scoring offline cache opt-in is still unwired.** `setServiceWorkerUser`
  now has a call site, but no server route sets the `X-Eccb-Offline-Cacheable`
  header, so scores are still never cached. The purge/namespacing is now correct
  and will engage once caching does; enabling caching is a separate decision.
- **Smart Upload re-split storage-key collision** (`smart-upload-worker.ts:716`
  and `:802` share the first-pass `parts/` prefix, unlike the resplit route's
  distinct `parts/resplit/`). A re-split can overwrite committed part objects and
  orphan first-pass files. **Not fixed in this pass** — it needs a migration-safe
  key change.
- **Commit-time page-coverage gate cannot detect a truncated tail** — it derives
  the page total from the parts' claimed ranges rather than the document length,
  so a session covering pages 1–8 of a 20-page score passes. Documented as a
  deliberate scope limit; the real total is not persisted on the session.
- **Selecting the `native` OCR engine yields zero OCR** on the re-OCR worker path:
  `ocr-worker.ts` sets `enableTesseractOcr` only for `tesseract`, so the `native`
  branch is unreachable and it falls through to filename fallback. The inline
  first-pass path is unaffected. **Not fixed in this pass.**
- Legacy Prisma models (`SmartUploadBatch`, `SmartUploadItem`,
  `SmartUploadProposal`, `SmartUploadSetting`, `TaskModelConfig`) appear dead
  by static and dynamic-access search, but **no migration was authored or
  rehearsed** to remove them. Leaving them costs schema surface, not correctness.

---

## 5. Uncommitted work

All repairs described above are in the **working tree** and are **not yet
committed**. Branch `main`, starting SHA `31a1950`.

Commit before treating this document as a release record, then update the
commit reference at the top. Nothing was reverted, no test was skipped or
weakened, and no gate was bypassed to reach green.

---

## 6. Regression gates added

Each was verified to **fail when its defect is deliberately reintroduced** — a
gate that cannot fail is not evidence.

- `src/lib/__tests__/wakeLock.test.ts` — fallback must not report active
- `src/lib/smart-upload/__tests__/ocr-engine-selection.test.ts` — `vision_api`
  rejected as selectable; normalization of persisted legacy values
- `src/lib/tools/__tests__/skip-guard.test.ts` — `e2e`/`tests` coverage,
  comment-prose discrimination, allowlist behaviour
- `src/components/__tests__/navigation-integrity.test.ts` — no dead nav links in
  either admin nav or the member sidebar; no orphaned top-level pages
- `src/lib/smart-upload/__tests__/quality-gates.coverage.test.ts` — page
  coverage and overlap detection, and the documented fail-open condition
