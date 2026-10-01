# ECCB.APP — Production Completion Plan

Status: **active**. Owner: principal engineer (this session).
Baseline: 2596 tests passing / 0 failing, typecheck + lint + build clean.

This plan is written against **verified repository state**, not the inherited
audit. Where the audit was wrong, that is recorded in `docs/audit-findings.md`.

---

## Part 0 — Blockers triage (read this first)

Three items were labelled "blockers". They are **not equal**, and one is not
dispatchable to an agent at all. Treating them identically would waste the
team on a task that requires the credential owner's authority.

| # | Blocker | Agent-dispatchable? | Why |
|---|---|---|---|
| B1 | `AGENTS.md` falsely claims offline/audio-sync settings work | **No** | `AGENTS.md` is a protected agent-instruction file. An edit attempt was **blocked pending approval and the prompt timed out**. A sub-agent hitting the same guard has no more authority. Requires the owner. |
| B2 | 5 live secrets in git history (`34667e6`) and on `origin/main` | **No** | Rotation is a side effect on *external systems* (the auth provider, S3, SMTP, VAPID keypair) that this environment cannot reach: no docker, no deployment SSH, DB is `localhost` dev only. Purging history additionally rewrites every SHA on `main`. Both are irreversible and owner-authorised decisions. |
| B3 | Two PDF splitter engines are `throw new Error` stubs | **Yes** | Real work, and the needed libraries are already present and are **runtime** deps: `@napi-rs/canvas` (loads OK), `sharp` 8.17.3, `pdfjs-dist` 5.5.207. |

**B1 and B2 are therefore owner tasks, not agent tasks.** They are listed in
"Owner actions" with exact instructions. B3 is dispatched as Workstream A.

Consequence: dispatching agents does **not** clear the release status. B2 in
particular is an active credential exposure and is the single strongest reason
to hold the release regardless of code quality.

---

## Workstream A — Smart Upload PDF split: replace the stub engines

**Owner: agent.** Shared files touched: `src/lib/services/pdf-splitter-adaptive.ts`
(lead owns; see "Conflict control").

### Problem

`src/lib/services/pdf-splitter-adaptive.ts` declares three engines behind
`adaptivelyExtractPages` (line 191) and `adaptiveSplitWithFallover` (line 282):

1. `pdf-lib` — real (`pdfLibEngine`).
2. `imageBasedEngine` (line 106) — **throws**, with a comment saying
   "This is a placeholder… throw to inform the operator".
3. `rawSliceEngine` (line 159) — **throws**, "experimental and not recommended".

`pdf-splitter.ts:24` imports `adaptiveSplitWithFallover`, so this is **live
production code on the Smart Upload split path**, not dead code. When a PDF
cannot be split by pdf-lib, the pipeline fails rather than degrading.

### Required work

**A1. Implement `imageBasedEngine` for real.**
Render each requested page to a bitmap with `pdfjs-dist` + `@napi-rs/canvas`,
then re-embed as image-only pages with `pdf-lib`.

- pdfjs v5 in Node needs a canvas factory. The installed
  `@napi-rs/canvas` provides `createCanvas`. Configure
  `NodeCanvasFactory` and set `GlobalWorkerOptions.workerSrc` to
  `pdfjs-dist/build/pdf.worker.mjs` (that file is already shipped at
  `public/pdf.worker.min.mjs`).
- **Never** use `require('pdfjs-dist/build/pdf.worker')` — the current code
  attempts this and it does not work in ESM. The repo is `"type": "module"`.
- Render at a deliberate DPI/scale (reuse the 1024px-width convention from
  `getDefaultOcrOptions` in `src/workers/ocr-worker.ts`).
- Return `{ buffer, pageCount }`; preserve page order and honour `pageIndices`
  exactly.

**A2. Decide `rawSliceEngine` honestly.**
Raw stream-slicing cannot be implemented safely. Choose ONE and justify:
- **(recommended) delete it** and remove it from the engine list. Two real
  engines is better than one real and one that throws. Update the
  `AdaptiveSplitResult.strategy` union and any switch on it.
- OR implement it only for the narrow case of a single contiguous page range
  with no object-stream compression. If chosen, it must have a test proving the
  output is a loadable PDF.

**A3. Fixture corpus.** Build `tests/fixtures/pdf/` generators (a script, not
committed binaries) producing: clean digital, scanned, rotated, skewed,
low/high-res, multi-part, multi-page part, conductor score, score+parts,
duplicate, unknown instrument, missing label, multi-label, blank page,
malformed, encrypted, very large. Assert page counts, grouping, title/composer,
instruments, confidence, review-required, and duplicate behaviour.

**A4. Tests.** Per-engine tests: image engine produces a valid PDF with the
requested pages only; fallback ordering (pdf-lib → image); final failure
surfaces a typed error, never a raw throw.

### Gate
`npx tsc --noEmit` · `npx eslint` · full vitest suite · new fixture script runs
green · **no** remaining `throw new Error` reached from a production import path.

---

## Workstream B — Authentication lifecycle completeness

**Owner: agent. Conflict-controlled: `src/lib/auth/config.ts` is lead-owned
(see below).**

### B5. Two-factor enrolment + login challenge
`src/lib/auth/config.ts:119` configures Better Auth's `twoFactor` plugin and
`src/lib/auth/client.ts` registers `twoFactorClient()`, but there is **no
route or UI for enrolment** (`find src/app -ipath '*two-factor*'` → empty).
A setting that does nothing is a dead feature.

Deliver enrolment, secret provisioning, QR + manual key, TOTP verification,
recovery codes, login second-factor challenge, disable-with-reauth, mandatory
2FA policy, audit logging, accessible UI, and E2E coverage. Use Better Auth's
own endpoints — do not invent a custom TOTP flow.

### B6. Admin impersonation
`src/app/api/admin/users/impersonate/route.ts` calls
`impersonateUser(userId)` from `admin/users/actions`. Verify it uses Better
Auth's supported impersonation primitive and actually establishes a session;
if it only generates a token, that is a dead feature. Require: audit event with
actor + target, visible banner, explicit exit, CSRF, session isolation, and a
test that impersonation does not escalate privilege.

### B7. Invitation lifecycle
`/signup?invite=…` was reported as not consuming the invite. Verify against
current code before building. If broken: crypto-strong token, DB-backed state,
expiry, single use, email binding, acceptance, audit trail.

### B8. Password reset + email verification audit
Verify non-enumerating responses, expiry, single use, session invalidation,
and that the member "Resend Verification Email" control actually works. Confirm
no `setState` is called during React render (a previously reported defect).

---

## Workstream C — Authorization and music-access boundaries

**Owner: agent.**

### B9. Reconcile the contradictory admin layouts
`src/app/(admin)/layout.tsx` allows `SUPER_ADMIN, ADMIN, DIRECTOR, STAFF,
LIBRARIAN`; nested `src/app/(admin)/admin/layout.tsx:51` requires `ADMIN`
only. A librarian therefore cannot reach `/admin/members` despite the sidebar
linking it. Build the matrix from `PERMISSIONS.md` +
`src/lib/auth/permission-constants.ts`, make server enforcement match, delete
the duplicate guard, and add a permission-matrix test that walks every admin
route and asserts the correct denial per role.

### B10. Stand access: `music.view.assigned` vs `music.view.all`
`src/lib/stand/access.ts` grants any ACTIVE member any non-archived piece
(`canAccessPiece` checks only `isArchived: false` + active member). Decide and
enforce: assignment granularity (piece vs part), whether a sibling part or
conductor score needs elevated permission, and whether librarians/directors get
global access. Enforce at page query, API, download, Stand, offline, search, and
direct URL. Add negative tests.

### B11. Canonical download architecture
Already unified: `POST /api/files/download-url` → signed `GET
/api/files/download/<key>?token=`. Verify the Stand file proxy and audio
endpoints use the same authorization rather than a parallel path.

---

## Workstream D — Observability, deployment, health

**Owner: agent. Conflict-controlled: `next.config.ts`, `.github/workflows/*`,
`scripts/*` are lead-owned.**

### B12. Health/readiness depth
`src/app/api/health/route.ts` checks DB, Redis, storage. Storage check is
configuration-only. Add a safe read-write-delete probe. Do not leak internals
publicly; split `/api/health` (liveness) from a readiness surface.

### B13. Deployment topology
`DEPLOYMENT.md` systemd unit runs **only** `next start`. Email, scheduler,
Smart Upload, OCR, cleanup and the socket worker all live in
`src/workers/index.ts` and `src/server/socket-worker.ts` and would never start.
Produce systemd units (or PM2 config) for all three processes, documented, with
graceful shutdown, queue draining, readiness, restart, and an ordered rollout +
rollback procedure. **Do not rotate credentials or touch real infrastructure.**

### B14. CI gates
`test.yml` now blocks on lint/typecheck/permissions/skipped-tests/secret-scan/
tests/links/build/`npm audit --audit-level=moderate`. Add a migration-from-empty
check and a route-authorization scan. Never reintroduce `continue-on-error` on
a security gate.

---

## Conflict control (lead-enforced)

These files are shared and unstable. **One writer at a time, lead
reconciles.** No two agents edit these concurrently.

```
package.json            prisma/schema.prisma      src/lib/auth/config.ts
src/proxy.ts            next.config.ts            .github/workflows/*
src/lib/env.ts          scripts/*                 src/lib/stand/settings.ts
```

Workstream A owns `pdf-splitter-adaptive.ts` exclusively. Workstream B must
propose (not apply) any `auth/config.ts` change for lead merge.

---

## Sequencing

1. **A** (scanner) — highest user-visible risk, fully parallel.
2. **B** (auth) — needs lead merge for `auth/config.ts`.
3. **C** (authz) — depends on B9's role matrix being settled by lead first.
4. **D** (ops) — after B, so readiness reflects real dependencies.

B3 and B5 are the two that most affect release posture.

---

## Owner actions (agents cannot do these)

1. **Rotate the 5 exposed secrets.** `AUTH_SECRET`, `BETTER_AUTH_SECRET`,
   `SETUP_TOKEN`, `SUPER_ADMIN_PASSWORD`, `ENCRYPTION_KEY` — all committed in
   `34667e6` and present on `origin/main`. Rotating `AUTH_SECRET` /
   `BETTER_AUTH_SECRET` invalidates all sessions (intended). This environment
   has no access to the issuing providers.
2. **Decide on history.** Leaving the values in history is only acceptable if
   they are rotated. Purging rewrites every SHA on `main` and force-pushes.
3. **Edit `AGENTS.md`.** Line 146 `stand.offlineEnabled — Enable offline
   caching` and line 149 `stand.audioSyncEnabled — Audio link editor` are false
   (no PWA, no audio editor). Correct wording is in README.md / GEMINI.md.
4. **Confirm npm vs pnpm.** The repository is normalized to npm on evidence
   (see `docs/TOOLCHAIN.md`); this contradicts the original brief's pnpm
   default. Confirm or reverse.

---

## Done means

Every Workstream gate passes; B1–B3 resolved or explicitly owner-accepted; the
release ladder (`security:scan-secrets`, `permissions:audit`, `typecheck`,
`lint`, `test:run`, `check-routes`, `build`) is green from a clean checkout.
