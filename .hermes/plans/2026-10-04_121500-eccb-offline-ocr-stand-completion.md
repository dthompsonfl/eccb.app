# ECCB Completion Plan — Offline Isolation, OCR, and Stand Coverage

> **For Hermes:** execute task-by-task, TDD, one commit per task.
> Do not mark a task done without the stated verification command producing the stated result.

**Goal:** Close the five open defects so that per-user offline data isolation is
real end-to-end, the Smart Upload pipeline has no selectable-but-dead paths or
storage collisions, and the Digital Music Stand's workflows have executable proof.

**Architecture:** Every fix reuses existing, already-correct abstractions —
`src/lib/stand/offline.ts` (pure policy), `public/sw.js` (worker), and
`performSignOut` in `src/lib/auth/sign-out.ts`. No new dependency is introduced.
The recurring theme is *unfinished wiring*: the isolation primitives already exist
and are correct; several were simply never connected.

**Tech stack:** Next.js 16 App Router, React 19, Prisma 7 + MariaDB,
BullMQ/Redis, tesseract.js, pdfjs-dist, Vitest, Playwright.

---

## Pre-flight: what "production ready" can and cannot mean here

This plan can make the **code** correct and prove it. Two things cannot be closed
from inside this repository, and no task below pretends otherwise:

1. **Cross-browser E2E.** Playwright cannot install firefox/webkit on
   Ubuntu 26.04 (`does not support chromium on ubuntu26.04-x64`). Task 6 adds
   Chromium-runnable coverage; the firefox/webkit/iOS matrix must be executed on a
   supported host before release. Recorded as an external gate, not a task.
2. **Live provider + infrastructure validation.** Real LLM/OCR credentials,
   production MariaDB/Redis/S3, SMTP and push. Code paths and config are
   verified; live delivery is an operational check.

Everything else below is closable in-repo and is planned as such.

---

## Workstream A — Per-user offline annotation queue (item 2)

**Problem.** `QUEUE_DB_NAME = 'eccb-offline'` (`src/lib/stand/offline.ts:201`) is a
single fixed IndexedDB with no user dimension. `openDb()` opens it unconditionally
(`use-offline-annotations.ts:39`), `readAll()` returns every entry, and `flush()`
filters by `musicId` only (`:162`). After an account switch on a shared rehearsal
tablet, user B loads user A's queued strokes and POSTs them under B's session.

The service-worker side is already correct (Task A0 proves this), so this is the
one remaining hole in the isolation story.

### Task A0: Lock in the service-worker behaviour that already works

**Objective:** Characterize current `sw.js` isolation so it cannot silently regress
while the queue is reworked.

**Files:**
- Test: `src/lib/stand/__tests__/offline.test.ts` (extend existing)

**Step 1: Read the existing test file and the exported policy surface.**

Confirm exported names before writing assertions: `cacheNameFor`,
`allCacheNamesFor`, `cacheBelongsToUser`, `isAppCacheName`,
`shouldCacheScoreResponse`, `OFFLINE_CACHE_HEADER`, `OFFLINE_USER_HEADER`.

**Step 2: Add characterization tests** pinning:
- `cacheNameFor('u1','score') !== cacheNameFor('u2','score')`
- `cacheBelongsToUser(cacheNameFor('u1','score'), 'u1') === true` and `=== false` for `'u2'`
- `shouldCacheScoreResponse` refuses when `userId` is null, status non-2xx, opt-in
  header absent, or `OFFLINE_USER_HEADER` names a different user
- `allCacheNamesFor('u1')` contains **no** name from `allCacheNamesFor('u2')`

**Step 3: Run and confirm they pass** against today's code (they should — this is
characterization, not new behaviour).

```bash
npx vitest run src/lib/stand/__tests__/offline.test.ts
```
Expected: all pass.

---

### Task A1: Add the user dimension to the queue policy

**Objective:** Make the store name a pure function of user id, mirroring
`cacheNameFor`.

**Files:**
- Modify: `src/lib/stand/offline.ts`

**Step 1: Write the failing test** in `src/lib/stand/__tests__/offline.test.ts`:

```ts
it('scopes the annotation queue database per user', () => {
  expect(queueDbNameFor('user-1')).not.toBe(queueDbNameFor('user-2'));
  expect(queueDbNameFor('user-1')).toContain('user-1');
});

it('refuses to open a queue without a user', () => {
  expect(queueDbNameFor(null)).toBeNull();
});
```

**Step 2: Verify it fails** — `queueDbNameFor` is not exported.

```bash
npx vitest run src/lib/stand/__tests__/offline.test.ts
```
Expected: FAIL — `queueDbNameFor is not a function`.

**Step 3: Implement minimally** in `src/lib/stand/offline.ts`, directly below
`QUEUE_DB_NAME` (line ~201):

```ts
/**
 * Per-user queue database name.
 *
 * The queue holds unsent personal annotations. A single shared database let one
 * musician's queued strokes be replayed under another's session after an account
 * switch, so the user id is the isolation boundary — the same model the service
 * worker already uses for cached scores.
 *
 * Returns null when there is no authenticated user: an anonymous queue has no
 * owner to scope it to, and silently sharing a fallback name is exactly the bug.
 */
export function queueDbNameFor(userId: string | null | undefined): string | null {
  const id = typeof userId === 'string' ? userId.trim() : '';
  if (!id) return null;
  return `${QUEUE_DB_NAME}-${CACHE_VERSION}-${id}`;
}

/** Legacy unscoped name, kept only so the migration can find and retire it. */
export const LEGACY_QUEUE_DB_NAME = QUEUE_DB_NAME;
```

Reuse `CACHE_VERSION` so a future format bump discards old queues alongside old
caches.

**Step 4: Verify it passes.**

**Step 5: Commit**
```bash
git add src/lib/stand/offline.ts src/lib/stand/__tests__/offline.test.ts
git commit -m "feat(stand): scope offline annotation queue per user"
```

---

### Task A2: Use the scoped store in the hook

**Objective:** Open, read and write only the current user's queue.

**Files:**
- Modify: `src/lib/stand/use-offline-annotations.ts`
- Test: `src/lib/stand/__tests__/use-offline-annotations.test.ts` (create)

**Step 1: Write the failing tests.** Cover, with `fake-indexeddb` if already a
dev dependency — **check `package.json` first**; if absent, test the pure helpers
instead of adding a dependency:

- `enqueue` then `flush` only ever sends the current user's items
- when `userId` is null, the hook performs **no** IndexedDB access and reports
  `syncState: 'synced'` with an empty queue (fail closed — never write to a
  shared/unknown store)
- `readAll` for user B does not return user A's entries

**Step 2: Verify failure.**

**Step 3: Implement:**
- Add `userId: string | null` to `UseOfflineAnnotationsOptions`.
- `openDb(userId)` returns `null` when `queueDbNameFor(userId)` is null.
- `readAll`/`writeAll` take the resolved db name; guard every call site so a null
  name short-circuits rather than falling back to the legacy name.
- Add a `userId` dependency to the load effect (`:132-146`) so switching accounts
  reloads that user's queue instead of showing the previous one.

**Step 4: Verify it passes**, then confirm no test regressed:
```bash
npx vitest run src/lib/stand/__tests__/
```

**Step 5: Commit** — `feat(stand): isolate offline annotation queue by user`

---

### Task A3: Retire the legacy unscoped queue safely

**Objective:** Handle any annotations already sitting in the old shared
`eccb-offline` database.

**Decision (security-first, state it in code):** entries in the legacy store
**cannot be attributed to a user**. Reading them under any identity would recreate
the exact cross-user leak being fixed. So they are **discarded, not migrated**.

**Files:**
- Modify: `src/lib/stand/use-offline-annotations.ts`

**Step 1:** On first scoped open, if `LEGACY_QUEUE_DB_NAME` exists, `deleteDatabase`
it. Log at debug level (never log stroke data — see the PII rule in `docs/SECURITY.md`).

**Step 2: Test** — legacy store present + new open ⇒ legacy deleted, new queue empty.

**Step 3:** Add an explicit comment stating the discard is deliberate and why, so a
future maintainer does not "helpfully" add a migration that reintroduces the leak.

**Step 4: Commit** — `fix(stand): discard unattributable legacy offline annotations`

> **Release note:** users with unsynced offline annotations at upgrade time lose
> them. This is intentional and must be stated in the release notes.

---

### Task A4: Purge the queue on sign-out

**Objective:** Signing out must leave no personal annotation data on the device.

**Files:**
- Modify: `src/lib/auth/sign-out.ts`
- Modify: `src/components/member/header.tsx`
- Test: `src/lib/auth/__tests__/sign-out.test.ts` (extend)

**Step 1: Extend `performSignOut`** with an optional `purgeUserData?: (userId) => void`
invoked **after** `signOut()` but **before** `redirect()`, wrapped so a throw
cannot block sign-out (same contract as the existing cache purge).

**Step 2: Tests:** purge called with the departing user id; purge called before
redirect; sign-out still succeeds if purge throws; existing ordering test
(purge → signOut → redirect) still holds.

**Step 3: Wire from `MemberHeader`**, which already receives `userId`.

**Step 4:** ```bash
npx vitest run src/lib/auth/__tests__/sign-out.test.ts
```
**Step 5: Commit** — `fix(stand): purge offline annotations on sign-out`

---

## Workstream B — Offline score-cache opt-in (item 3)

**Problem.** `shouldCacheScoreResponse` requires the server to set
`X-Eccb-Offline-Cacheable: true` (`src/lib/stand/offline.ts:143,169`). **No route
sets it**, so scores are never cached and the entire offline-score path is dead
code that reads as a working control.

Separately, `public/sw.js` has a three-way naming inconsistency:
`appShellCache()` (line 200) returns `eccb-stand-v1-app-shell` — **no user id** —
while `matchForUser` (line 238) reads `cacheNameForUser('app-shell', currentUserId)`
and `purgeUserCaches` (line 207) deletes the same namespaced form. So the app-shell
cache is written to one name and read from another: never read, never purged.

**This is a latent cross-user leak, not just dead code.** `classifyRequest`
(`offline.ts:77`) classifies navigations as `app-shell`. A cached `/member/...`
navigation response embeds the signed-in member's name. The day the read path is
"fixed" without also namespacing the write path, one member's rendered shell is
served to another. Fix the write path *first*.

### Task B1: Make the app-shell cache namespaced (fix before enabling anything)

**Files:**
- Modify: `public/sw.js`
- Test: `src/lib/stand/__tests__/offline.test.ts` (policy) + a sw.js text assertion if no harness exists

**Step 1: Test** that the worker's app-shell cache name includes the user id, and
that it matches `cacheNameFor(userId,'app-shell')`.

**Step 2: Fix** `appShellCache()` to return `cacheNameForUser('app-shell', currentUserId || 'anon')`,
matching `staticAssetCache()` which already does exactly this (line 203).

**Step 2b: Fix the second, related defect.** `purgeUserCaches` (`:207`) deletes
`cacheNameForUser('app-shell', userId)` — which is *not* the cache `install` (`:84`)
actually populated. So `eccb-stand-v1-app-shell` survives logout. It holds only
`/`, `/offline` and `/manifest.json` (no copyrighted content), so it is benign
today — but it makes the code's own comment, "logout purges the user's caches,"
false. After B1's namespacing this resolves itself; assert it in the F2 tests.

**Step 2c: Note the pre-`SET_USER` window.** `staticAssetCache()` (`:204-206`)
falls back to the literal `'anon'` whenever `currentUserId` is null, which is the
state on first load before the header effect runs. Static assets are not
user-specific, so this is acceptable — but document it, because it is the one
place a non-namespaced cache name still exists by design.

**Step 3:** Re-read `matchForUser` — the `if (!currentUserId) return undefined`
early-return already prevents serving any user cache anonymously. Confirm this and
keep it.

**Step 4: Commit** — `fix(stand): namespace app-shell cache by user`

---

### Task B2: Set the opt-in header on the Stand file route

**Objective:** Make offline score caching actually work, gated by the existing
admin settings and only for a score the member explicitly cached.

**Files:**
- Modify: `src/app/api/stand/files/[...key]/route.ts`
- Read: `src/lib/stand/settings.ts` (`stand.offlineEnabled`, `stand.allowOfflineSync`)

**Preconditions (do not skip):**
- The response must be authorized first — the header must only be added on a
  response the requester is *entitled* to. Set it **after** the access check, never
  before.
- Only for `200` responses serving actual PDF bytes.

**Step 1: Test** the response-marker helper as a pure function before wiring it:
extract `markScoreResponseCacheable({ headers, enabled, userId })` and assert it
adds the header only when `enabled && userId` are both truthy.

**Step 2: Wire** it into the route, gated on `stand.offlineEnabled` from settings.

**Step 3: Verify negatively** — with `stand.offlineEnabled=false`, the header is
absent and nothing is cached.

**Step 4: Commit** — `feat(stand): opt authorized scores into offline cache`

> **Security gate:** this task makes copyrighted music persist on a device. Do not
> land it until B1 has merged. Reviewers must confirm the header cannot be set on
> a response the user is not entitled to, including error and redirect responses.

---

### Task B3: Prove cross-user isolation with executable tests

**Objective:** Convert "should not leak" into a test that fails if it does.

**Files:**
- Test: `src/lib/stand/__tests__/offline.test.ts`

**Step 1:** Assert `shouldCacheScoreResponse` refuses when
`OFFLINE_USER_HEADER` names another user, even with the opt-in header present.

**Step 2:** Assert a user-1 cache name is never returned for a user-2 lookup.

**Step 3: Assert `allCacheNamesFor('u1')` and `allCacheNamesFor('u2')` are disjoint
**after** B1 (this is the assertion that fails today for `app-shell`).

**Step 4: Commit** — `test(stand): pin per-user offline cache isolation`

---

## Workstream C — Smart Upload `native` OCR (item 4b)

**Problem.** `src/workers/ocr-worker.ts:85` sets
`enableTesseractOcr: cfg.ocrEngine === 'tesseract'`. But
`src/lib/services/ocr-fallback.ts:713` gates on
`enableTesseractOcr && (ocrEngine === 'tesseract' || ocrEngine === 'native')`.
Selecting **`native`** therefore sets the flag false, making its own branch
unreachable and falling through to filename fallback — **zero OCR, silently**.
The inline first-pass path is unaffected because it passes
`enableTesseractOcr: llmConfig.enableOcrFirst ?? true`
(`smart-upload-processor.ts:1062`).

**Decision: fix, do not remove.** Evidence that `native` is a real product option:
it is offered in the settings form, `ocr-fallback.ts` implements a distinct branch
for it (`case 'native'` returns a Tesseract result, and the `tryOcrEngine` default
branch does the same), and the inline path honours it. This is an enablement bug,
not a phantom feature.

### Task C1: Fix the enablement condition

**Files:**
- Modify: `src/workers/ocr-worker.ts:85`
- Test: create `src/workers/__tests__/ocr-worker-engine.test.ts`

**Step 1: Write the failing test** — extract the default-options builder into a
pure exported function `buildOcrDefaults(cfg)` and assert:

```ts
expect(buildOcrDefaults({ ocrEngine: 'native' }).enableTesseractOcr).toBe(true);
expect(buildOcrDefaults({ ocrEngine: 'tesseract' }).enableTesseractOcr).toBe(true);
expect(buildOcrDefaults({ ocrEngine: 'ocrmypdf' }).enableTesseractOcr).toBe(false);
```

**Step 2: Verify it fails** for `native` (currently `false`).

**Step 3: Fix:**
```ts
enableTesseractOcr: cfg.ocrEngine === 'tesseract' || cfg.ocrEngine === 'native',
```

**Step 4: Also verify** the job-data override at `ocr-worker.ts:276` still wins, so
an operator can hard-disable OCR regardless of engine.

**Step 5: Verify** the extracted builder is used by the real call path so the test
tests production behaviour, not a parallel copy.

**Step 6: Commit** — `fix(smart-upload): enable OCR for the native engine`

---

## Workstream D — Re-split storage-key collision (item 4a)

**Problem.** Three sites confirmed:

| Site | Key |
|---|---|
| `smart-upload-processor.ts:2100` (first pass) | `smart-upload/${sessionId}/parts/${slug}.pdf` |
| `smart-upload-worker.ts:716` (second-pass re-split) | **identical** |
| `smart-upload-worker.ts:802` (re-split branch) | **identical** |
| `smart-upload-processor.ts:2371` (heal path) | `.../parts/heal/${slug}.pdf` ← already namespaced |
| `resplit/route.ts:229` | `.../parts/resplit/${slug}.pdf` ← already namespaced |

The codebase **already has the convention** (`parts/heal/`, `parts/resplit/`);
only `smart-upload-worker.ts` fails to follow it. `slug` includes `partNumber`
and page range (`part-naming.ts:274-279`), so a re-split that changes the page
range yields a *different* key and orphans the first-pass object — while
`cleanupSmartUploadTempFiles` (`smart-upload-cleanup.ts:105`) skips keys the
session still lists, so the orphan is never reclaimed.

### Task D1: Fix `tempFiles` bookkeeping so orphaned part objects are reclaimed

> **Corrected after investigation.** The original framing — "re-split overwrites
> first-pass objects" — **does not hold**. The slug *bases* differ structurally
> (first pass builds from `` `${extractedTitle} ${instrument}` ``, `part-naming.ts:360,367`;
> second pass from bare `part.instruction.partName`, `worker.ts:712`) and the page
> suffixes differ because the processor splits `indexing: "zero"`
> (`smart-upload-processor.ts:1973`) while the worker splits `indexing: "one"`
> (`worker.ts:702,788`). Overwrite is effectively unreachable.
>
> The **certain** harm is orphaned storage, and it has nothing to do with the key
> prefix. Renaming the prefix would not fix it.

**Problem (the actual defect).**

| Site | Behaviour |
|---|---|
| `smart-upload-worker.ts:755` | `updateData.tempFiles = tempFiles;` **replaces** the array with only second-pass keys |
| `smart-upload-worker.ts:836` | re-split branch updates `parsedParts` but **never touches `tempFiles` at all** |

`cleanupSmartUploadTempFiles` keys strictly off `session.tempFiles`
(`smart-upload-cleanup.ts:49`, filter at `:105`) and never enumerates the bucket
prefix. So:

- At `:755` every first-pass object is dropped from `tempFiles` → unreachable
  garbage, never deleted, on **both** commit and reject.
- At `:836` `parsedParts` reference second-pass keys while `tempFiles` still lists
  first-pass keys → cleanup deletes the wrong objects, and a later reject of that
  session leaves the new ones behind.

**Files:**
- Modify: `src/workers/smart-upload-worker.ts` (lines 755, 836)

**Step 1: Write failing tests** on an extracted pure helper, e.g.
`accumulateTempFiles(existing, incoming)` in
`src/lib/smart-upload/persistence.ts`, asserting:
- first-pass keys are **retained** when second-pass keys are added
- duplicates are not added twice
- the result is de-duplicated and order-stable

**Step 2: Verify failure.**

**Step 3: Implement** — both branches must *accumulate* into the existing session
list rather than assign a fresh array. Parse the existing value with
`parseSmartUploadJsonArray` from `@/lib/smart-upload/persistence` (it is stored as
a JSON string) and union it with the new keys.

**Step 4: Confirm no data migration is required.** Verified: nothing in `src/`
queries, lists, or parses by a `smart-upload/` prefix — no `startsWith('smart-upload')`,
no prefix-based storage listing. The prefix is session-scoped and all persisted
`storageKey` values are absolute strings. Already-committed rows keep pointing at
objects that still exist under their original keys; in-flight sessions hold
absolute keys in `parsedParts` and are unaffected. **No migration.**

**Step 5: Separately, adopt the existing subdirectory convention** as defence in
depth — `smart-upload-processor.ts:2371` already uses `parts/heal/` and
`resplit/route.ts:229` uses `parts/resplit/`, so the two worker sites are the only
un-isolated writers. Extract one shared `partKey(sessionId, slug, variant)` helper
used by all five sites so the convention cannot drift again. This is hygiene, not
the bug fix; land it after D1's tests are green.

**Step 6: Commit** — `fix(smart-upload): accumulate temp files across re-split passes`

---

## Workstream E — Commit-time page-coverage tail (item 4c)

**Problem.** `src/lib/smart-upload/commit.ts:176` computes coverage total as
`Math.max(...withRanges.map(p => p.pageRange[1]))` — the span parts **claim**, not
the document's real length. A session covering pages 1–8 of a 20-page score passes.
The processor (`:2011`) and resplit route (`:176`) *do* hold the authoritative
count; `SmartUploadSession` persists **no** page-count field (verified against
`prisma/schema.prisma`).

Note this is the *separate* concern from the fail-open fixed earlier: that fix
handled an **unknown** page count; this is a **known-but-ignored** count.

### Task E1: Persist the authoritative source page count

**Files:**
- Modify: `prisma/schema.prisma` (`model SmartUploadSession`)
- Create: `prisma/migrations/<timestamp>_smart_upload_source_page_count/migration.sql`

**Step 1: Design.** Additive **nullable** column:
```prisma
sourcePageCount Int?
```
Nullable is required for safety: in-flight sessions have no value, the column is
additive (no data loss), and old app versions ignore it. **Deploy order is
backward compatible** — app rollback after migration still works.

**Step 2: Write the migration** — `ALTER TABLE ... ADD COLUMN ... INT NULL`.
No backfill in the migration (values are not recoverable retroactively); the
processor populates on write.

**Step 3: Verify the migration against a disposable database**, not production:
```bash
npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma \
  --to-migrations prisma/migrations --shadow-database-url "$DISPOSABLE_URL" --exit-code
```
Expected: exit 0 (no drift).

**Step 4: Populate it** at the sites that already know the count —
`smart-upload-processor.ts` and `resplit/route.ts`, using
`getAuthoritativePdfPageCount` / `getPdfSourceInfo`.

**Step 5: Commit** — `feat(smart-upload): persist authoritative source page count`

> **Stop condition:** if step 1 of Task D1 shows committed rows referencing
> `smart-upload/%` keys, halt and escalate — that is a data-recovery decision, not
> an implementation one.

---

### Task E2: Use the real count at commit time

**Files:**
- Modify: `src/lib/smart-upload/commit.ts`

**Step 1: Write failing tests:**
- session with `sourcePageCount=20` and parts covering 1–8 ⇒ coverage failure
- session with `sourcePageCount=20` and parts covering 1–20 ⇒ pass
- session with `sourcePageCount=null` ⇒ **existing** behaviour (claimed span) plus
  a warn-level log — must not regress or hard-block legacy sessions

**Step 2: Verify failure** on the first case (currently passes).

**Step 3: Implement** — prefer `sourcePageCount`; when it is **null, fail
closed**: force `requiresHumanReview` rather than silently falling back to the
claimed span. This matches the precedent already set by the earlier fail-open fix
at `smart-upload-worker.ts:878-898`, and it is the honest reading: a session whose
true page count was never recorded cannot be verified, so a human confirms it.
In-flight sessions created before the migration read `null` and therefore route to
review — correct, and bounded in cost because Smart Upload sessions are transient.

**Step 4: Cover every commit entry point.** All three funnel through the single
gate at `commit.ts:497`, so one fix covers them — but test each, because a
bypassed gate is exactly the failure mode being closed:
- `src/app/api/admin/uploads/review/[id]/approve/route.ts:96`
- `src/app/api/admin/uploads/review/bulk-approve/route.ts:94` (loops the same call)
- autonomous: `src/workers/smart-upload-processor-worker.ts:87`, queued from
  `smart-upload-processor.ts:2535` / `smart-upload-worker.ts:971`

**Step 5: Commit** — `fix(smart-upload): validate coverage against the real page count`

---

## Workstream F — Digital Music Stand proof (item 5)

### Task F1: Record the real coverage baseline

> **Corrected after investigation.** An earlier draft of this plan assumed Stand
> specs were dead because `stand/*.spec.ts` appears in a `testIgnore` list. That
> was wrong: they are excluded from the *generic* projects but run in a **dedicated
> `stand` project** (`playwright.config.ts:189-197`) configured with Desktop
> Chrome **plus `chromeLaunch`**, `dependencies: ['setup']`, `workers: 1`. So all
> **21 Stand tests execute today** and were part of the 30/30 Chromium pass.

**Objective:** Write down what actually runs, so the remaining gap is not guessed at.

**Step 1:** Record this table in `RELEASE_READINESS.md`:

| Workflow | Spec | Runs in Chromium? |
|---|---|---|
| Load PDF (PDF.js rasterises) | `e2e/stand/stand-workflow.spec.ts` | yes |
| Page turn (toolbar Next/Prev) | same | yes |
| Annotate + persist across reload | same (`:138-193`) | yes |
| Second stroke is a distinct row | same (`:195-229`) | yes |
| Blank page stays blank | same (`:231-266`) | yes |
| Two-page spread toggle / recto align | `stand-two-page-spread.spec.ts` | yes |
| Zoom + clamp + persistence | `stand-view-preferences.spec.ts` | yes |
| Large-print text scaling | `stand-large-print.spec.ts` | yes |
| Offline annotate → queue | **none** | — |
| Reconnect → replay → drain | **none** | — |
| Account-switch isolation | **none** | — |
| `public/sw.js` behaviour | **none** | — |

**Step 2:** State the headline honestly: the *rendering and annotation* surface is
well covered; the entire **offline, service-worker and reconnect** surface has
**no executable test of any kind**.

---

### Task F2: Make `public/sw.js` testable

**Objective:** `sw.js` currently has **zero** tests — it is a non-module global
script, nothing imports or mounts it. Every isolation guarantee in it is
unverified.

**Files:**
- Create: `src/lib/stand/__tests__/sw-policy.test.ts`
- Modify: `public/sw.js` only if a seam is needed

**Step 1:** Extract the pure decision functions from `sw.js` into a module that
Vitest can import — `appShellCacheName(userId)`, `staticAssetCacheName(userId)`,
`shouldServeFromUserCache({ currentUserId, cacheName })`. Keep `sw.js` as a thin
bootstrapper that imports/bundles them, so there is exactly one implementation.

**Step 2:** Write failing tests pinning the guarantees that matter:
- `matchForUser` refuses when `currentUserId` is null
- no function ever opens a cache whose name lacks the current user id
- `purgeUserCaches('u1')` returns names that are a subset of `allCacheNamesFor('u1')`
  — **this fails today for `app-shell`** (see Task B1)
- `SET_USER` with a different id purges the previous user first
- `LOGOUT` purges then nulls

**Step 3: Verify the app-shell assertion fails** (it should — Task B1's bug),
then implement B1 and re-run to green.

**Step 4: Commit** — `test(stand): make service-worker cache policy testable`

---

### Task F3: Cover the untested workflows

**Objective:** Executable proof for the workflows named as unexercised.

For each, write the spec, run it red, implement/fix only if it reveals a defect,
then run green:

1. **Account switch does not leak queued annotations** — the highest-value test
   in this workstream. Sign in as A, queue an annotation offline, sign out, sign in
   as B, assert B's queue is empty and A's annotation was not POSTed under B.
2. **Offline queue survives reload** — enqueue, reload, assert still queued.
3. **Reconnect flushes exactly once** — duplicate delivery must not double-post.
4. **Sign-out purges** — assert the queue and caches are empty afterwards.
5. **Page annotation persistence** — draw, reload, assert the stroke returns.
6. **Access denial** — a member with no assignment gets no score bytes.

**Verification per spec:** run it, confirm it **fails for the right reason** when
the protection is removed, then passes. A spec that has never gone red proves
nothing.

**Commit per spec.**

---

### Task F4: Document the cross-browser gap precisely

**Files:**
- Modify: `RELEASE_READINESS.md`

**Step 1:** Record exactly which specs run on Chromium and which require
webkit/firefox, with the reason (`does not support … on ubuntu26.04-x64`).

**Step 2:** Provide the exact command for a supported host:
```bash
npx playwright install --with-deps && npx playwright test
```
**Step 3:** List it as an **external release gate**, not a completed item.

---

## Final validation ladder

Run every one; record the actual result. Do not proceed on a failure.

```bash
npm run lint
npm run typecheck
npm run permissions:audit
npm run security:scan-secrets
npm run security:check          # expect 0 vulnerabilities
npm run test:run                # expect all pass, no skips
npm run db:generate
npm run build
npm run start:all &             # app :3225, health :3229
PLAYWRIGHT_BASE_URL=http://localhost:3225 \
PLAYWRIGHT_CHROME_EXE=/usr/bin/google-chrome \
  npx playwright test \
    --project=setup --project=chromium --project=stand \
    --project=admin --project=a11y-public
```

> **Include `--project=stand`.** It is a separate project from `chromium`; omitting
> it silently drops all 21 Digital Music Stand tests. Always print the per-project
> counts, never the bare total — a "total" hides exactly this class of omission
> (it already hid 60 failures once via output truncation).

Plus the disposable-database migration rehearsal (Task E1) and a live
`npm run db:seed` idempotency check.

---

## Risk register

| Risk | Severity | Mitigation |
|---|---|---|
| B2 makes copyrighted music persist on shared devices | **High** | B1 lands first; header set only post-authorization; isolation proven by B3 tests |
| A3 discards queued offline annotations at upgrade | Medium | Intentional and documented; entries are unattributable so migration would recreate the leak |
| E1 schema change | Medium | Additive nullable column; no backfill; rollback-safe; rehearsed on disposable DB |
| D1 storage-key change orphans live objects | Medium | Query live DB first; halt if committed rows reference temp keys |
| F2 unblocks specs that were never running | Low | Purely additive; reveals latent failures that must then be fixed, not suppressed |
| C1 changes OCR output for `native` users | Low | Previously produced *nothing*; any output is an improvement |

---

## Definition of done

- [ ] A1–A4: offline annotation queue is per-user, purged on sign-out, legacy store retired
- [ ] B1–B3: app-shell cache namespaced, opt-in header wired post-authorization, isolation proven by test
- [ ] C1: `native` engine performs OCR; enablement unit-tested
- [ ] D1: `tempFiles` accumulated across passes so no part object is orphaned; shared key helper adopted; no migration needed (verified)
- [ ] E1–E2: `sourcePageCount` persisted via additive migration; commit gate uses it and **fails closed** on null; all three commit entry points covered
- [ ] F1: coverage table recorded in `RELEASE_READINESS.md` (21 Stand tests already run in the `stand` project)
- [ ] F2: `public/sw.js` decision functions extracted and tested; app-shell purge assertion green
- [ ] F3: account-switch isolation, offline queue, reconnect/drain, annotation persistence and access denial specs exist and have each been **red-then-green**
- [ ] F4: cross-browser gap recorded as an **external gate**, not a completed item
- [ ] Full validation ladder green, **including `--project=stand`**, results recorded per project
- [ ] `RELEASE_READINESS.md` updated with real numbers, not intentions
- [ ] Cross-browser matrix and live-provider checks recorded as external gates, explicitly not claimed as passed
