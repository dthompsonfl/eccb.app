# ECCB — Verify, Fix the Live Defects, Consolidate Status Evidence

## Goal

Make the status of `/home/dylan/eccb.app` **provable**, close the code defects that are
still real, and stop the repo accumulating a twelfth contradictory status document.

## Scope

**In scope:** (1) run the gate ladder and record real output; (2) fix offline score-cache
opt-in; (3) fix unvalidated provider casts in `loadLLMConfig`; (4) archive the ten
superseded root-level reports behind a single commit-stamped status document.

**Explicitly out of scope** (agreed): building the `ENTERPRISE_MUSIC_MANAGEMENT_REVIEW.md`
feature roadmap; removing the five dead Prisma models (deferred — see Task 4); any
SOLID/architecture refactor; cross-browser E2E and live-provider validation (external).

**Not in this repo:** the `garden-intelligence-web` build failure in the original request.
Different application, different workspace, unrelated to any file here.

---

## Context the implementer needs

The feature work is substantially **done**. Verified by reading source (nothing was
executed — see Task 0):

| Item | Evidence |
|---|---|
| Per-user offline annotation queue | `src/lib/stand/offline.ts:252,264`; used at `use-offline-annotations.ts:183,314`; purged via `sign-out.ts:51` → `components/member/header.tsx:65` |
| App-shell cache namespaced per user | `public/sw.js:225-226` |
| `native` OCR engine enabled | `src/workers/ocr-worker.ts:100` (`resolveEnableTesseractOcr`) |
| `sourcePageCount` + fail-closed coverage gate | `schema.prisma:485`, migration `20261004140000_smart_upload_source_page_count`, written at `smart-upload-worker.ts:463`, `smart-upload-processor.ts:2501`, `resplit/route.ts:270`, consumed at `commit.ts:135-190,521-525,1120` |

The prior plan `.hermes/plans/2026-10-04_121500-eccb-offline-ocr-stand-completion.md`
executed successfully but **never ticked its 12 Definition-of-Done boxes**. Do not treat
its unchecked boxes as undone work — verify against source, as above.

`TODO.md` and `RELEASE_READINESS.md` disagree on test count (3927 vs 4151), as does
`COMPLETION_CHECKLIST.md` (812). `RELEASE_READINESS.md` §2 claims `config-loader.ts`
"previously used an unchecked `as` cast" — **that claim is false**, see Task 3.

---

## Task 0 — Unblock verification (BLOCKING, needs the user)

Bash is hard-denied in the agent permission set: `npm`, `tsc` and `eslint` are all blocked
by a catch-all `{"permission":"*","action":"deny","pattern":"*"}` that overrides the
allow-list. Answering the in-session question about permissions did not change it.

**Every task below that says "verify" is blocked until this is resolved.**

Ask the user to either:

- **(a)** allow `npm run *`, `npx tsc`, `npx eslint`, `npx vitest`, `npx playwright`, or
- **(b)** run each command themselves and paste the raw output.

Do not mark any verification step complete on the strength of a pre-existing document.

---

## Task 1 — Run the gate ladder, record real numbers

Canonical ladder is `RELEASE_GATES.md`. Run and capture the actual exit code and output of
each, in order. Do not proceed past a failure; fix or classify it.

```bash
npm run lint
npm run typecheck
npm run permissions:audit
npm run security:scan-secrets
npm run security:check          # expect 0 vulnerabilities
npm run test:run                # expect all pass, no skips
npm run db:generate
npm run build
```

Then E2E. **Include `--project=stand`** — it is a separate project from `chromium`, and
omitting it silently drops every Digital Music Stand test:

```bash
npm run start:all &
PLAYWRIGHT_BASE_URL=http://localhost:3225 \
PLAYWRIGHT_CHROME_EXE=/usr/bin/google-chrome \
  npx playwright test \
    --project=setup --project=chromium --project=stand --project=admin \
    --project=a11y-public --project=a11y-member
```

Print **per-project** counts, never the bare total — a total hid 60 failures once already.

**Acceptance:** every command's real output is recorded verbatim in the Task 5 status
document. Where a gate cannot run here (WebKit/Firefox binaries unavailable on this host),
record it as an **external gate**, explicitly *not* claimed as passed.

---

## Task 2 — Fix the dead offline score-cache path

**Defect.** `OFFLINE_CACHE_HEADER` is exported at `src/lib/stand/offline.ts:143` and
consumed by `shouldCacheScoreResponse`, but **no route sets it**. Scores are therefore
never cached: `stand.offlineEnabled` / `stand.allowOfflineSync` are honest kill-switches
that currently do nothing, and the whole offline-score path is dead code that reads as a
working control.

**Fix** — `src/app/api/stand/files/[...key]/route.ts`:

1. Extract a pure helper `markScoreResponseCacheable({ headers, enabled, userId })` into
   `src/lib/stand/offline.ts`. It sets the header **only** when `enabled && userId` are
   both truthy.
2. Gate `enabled` on `getStandSettings().offlineEnabled` (`src/lib/stand/settings.ts:32`).
   Note `settings.ts:174-177` keeps `offlineEnabled` and `allowOfflineSync` in lockstep —
   do not introduce a third flag.
3. Call the helper **strictly after** the authorization/access check, never before, and
   only on `200` responses carrying actual PDF bytes. It must be impossible to set the
   header on an error, redirect, or unauthorized response.
4. Confirm the response is for a piece the member is actually assigned to — the delivery
   route's existing access check, not a new policy.

**Tests** (`src/lib/stand/__tests__/offline.test.ts`, extend):

- header added when `enabled && userId` present; absent when either is falsy.
- helper refuses when `OFFLINE_USER_HEADER` names a different user even if opt-in present.
- `allCacheNamesFor('u1')` and `allCacheNamesFor('u2')` are disjoint (regression guard for
  the `sw.js` app-shell fix).
- Negative integration assertion: with `offlineEnabled=false`, no header, nothing cached.

**Acceptance:** an integration test proves a score an entitled member requested is
cacheable, and one proves an unentitled member's response never carries the header.

> Copyrighted music will now persist on member devices. The per-user namespacing in
> `public/sw.js:225` must already be merged — it is (verified above). Re-verify it before
> landing this task; do not land without that guard.

---

## Task 3 — Replace unvalidated provider casts in `loadLLMConfig`

**Defect.** `src/lib/llm/config-loader.ts` reads free-text `SystemSetting` rows and asserts
them into the provider enum without validation:

- `:252-256` `llm_default_provider` / `llm_provider` → `as LLMProviderValue`
- `:259-262` four per-step provider keys → `as LLMProviderValue`
- `:297` `ocrMode as 'header' | 'full' | 'both'`

Any string an admin types into the Smart Upload settings form flows straight into the
pipeline as a provider identifier. A typo yields a dead provider with no error at the
boundary — this is the `CODE_REVIEW_UNCOMMITTED.md` CRITICAL-2 finding, still open.

**Fix:**

1. Add a single validating resolver, e.g. `resolveProviderSetting(raw, fallback)` and
   `resolveOcrModeSetting(raw)`, that checks membership in the canonical provider set and
   the canonical OCR-mode set.
2. On a value outside the set: fall back to the documented default (`'ollama'` for
   provider, `'both'` for `ocrMode`), log a **warning** naming the offending setting key
   and value, and continue. Do not throw — a mistyped admin setting must not take the
   Smart Upload pipeline down.
3. Delete all seven `as` casts. Every provider value reaching `loadLLMConfig`'s return must
   have passed through the resolver.
4. Keep the existing per-step → default → legacy → `'ollama'` precedence exactly as-is.

**Tests** (`src/lib/llm/__tests__/config-loader.test.ts`, extend):

- valid provider round-trips unchanged, for every member of the canonical set.
- `'not-a-provider'` → `'ollama'` + one warning + no throw.
- each of the five per-step keys independently falls back.
- `ocrMode: 'garbage'` → `'both'`.
- **Also address the adjacent silent-failure path:** `getPrimaryApiKey`
  (`api-key-service.ts:334`) returns `''` when decryption fails. Make that observable —
  log a warning without the key material, and have the resolver surface "provider
  configured but no usable key" rather than a bare empty string. Never log the key.

**Acceptance:** no `as LLMProviderValue` remains in `config-loader.ts`; a bad setting
produces a warning and a working fallback rather than a silent dead pipeline.

---

## Task 4 — Document the deferred dead-model removal (no code change)

Agreed decision: do **not** migrate. Record in the Task 5 status document:

Five models are dead — zero references anywhere in `src/`
(`SmartUploadBatch`, `SmartUploadItem`, `SmartUploadProposal`, `SmartUploadSetting`,
`TaskModelConfig` at `schema.prisma:1036,1057,1083,1116,1303`). The apparent 4 hits from a
grep are the unrelated local `smartUploadSettings: settingsSnapshotSummary`.

Removal was deliberately deferred, with the reason, because it is **not one blast radius**:

- The first four form a self-contained cascade cluster (`:1049-1050,1076-1077`).
- `TaskModelConfig` holds **4 FK relations into the live `AIModel` and `AIProvider` models**
  (`:1315-1318`), so removal also requires deleting four back-relation fields on those
  models and dropping four FK constraints.
- Six enums become orphaned.
- `@@ignore` is **not** a clean escape: Prisma rejects an ignored model with required
  relations to non-ignored models. There is no reversible option here.

File the removal as a follow-up requiring a schema-change window, with the row-count and
FK-dependency check specified so the next implementer does not re-derive it.

---

## Task 5 — Consolidate the status documents

Ten root-level reports currently make **19 mutually incompatible claims**: three different
test counts (812 / 3927 / 4151), two opposite verdicts on `npm run build`, per-route vs.
central CSRF enforcement, and three different definitions of the mandatory gate ladder.

1. **Author one** `STATUS.md` at the repo root, tied to a **commit SHA**, containing: the
   gate ladder and each command's real recorded result; the verified-complete inventory
   (Task 0 table); the two defects fixed here; the Task 4 deferral; and the external gates
   (cross-browser E2E, live LLM/OCR credentials, production MariaDB/Redis/S3, SMTP/push,
   backup-and-restore rehearsal) each explicitly marked **not validated here**.
2. **`git mv` the ten superseded reports into `docs/archive/`**, preserving history:
   `CODE_REVIEW_UNCOMMITTED.md`, `DEEP_PRODUCT_COMPLETION_REPORT.md`,
   `ENTERPRISE_IMPLEMENTATION_ROADMAP.md`, `ENTERPRISE_MUSIC_MANAGEMENT_REVIEW.md`,
   `PRODUCTION_READINESS_SWEEP.md`, `COMPLETION_CHECKLIST.md`, `RELEASE_READINESS.md`,
   `RELEASE_GATES.md`, `ERROR_FIX_REPORT.md`, `MUSIC_ADMIN_ENHANCEMENT_SUMMARY.md`.
3. **Replace each original root path with a one-line stub** naming `STATUS.md` as
   authoritative and stating that the archived copy describes an earlier tree.
4. Keep `RELEASE_GATES.md` content **merged into** `STATUS.md` (it is the gate ladder, and
   it must not be lost), and keep `ENTERPRISE_MUSIC_MANAGEMENT_REVIEW.md` in the archive
   intact — it is the roadmap for out-of-scope future work.
5. Do **not** update `TODO.md` completion claims beyond the two fixes; it currently cites
   test counts that Task 1 will supersede, so correct those numbers to the recorded ones.

**Never claim:** HIPAA or PCI-DSS compliance (neither applies — see `AGENTS.md`), or that
any external gate passed. Name what a control does and what is missing.

---

## Task 6 — Final validation

Re-run the full Task 1 ladder after Tasks 2 and 3. Every command must be green, with
`--project=stand` included. Confirm:

- No new ESLint errors or warnings; no `@ts-expect-error` or `as any` introduced.
- `prisma validate` passes (schema untouched, but Task 3 touches types).
- `npm run permissions:audit` still passes (Task 3 must not weaken any permission).
- `git status` shows the archive moves and the new `STATUS.md`; no stray build output.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Task 0 never unblocks; plan cannot verify anything | **High** | Stop and ask the user rather than substituting document claims for evidence |
| Task 2 makes copyrighted music persist on shared devices | High | `sw.js` per-user namespacing is already merged (verified); header set only post-authorization, 200-only; Task 5 records the change in release notes |
| Task 3's fallback masks a genuinely broken provider config | Medium | Warn-level log naming the setting key; surfaced as "configured but no usable key", never silent |
| Task 5 loses information or breaks inbound links | Medium | `git mv` preserves history; stubs at every original path; `RELEASE_GATES.md` content merged, not deleted |
| Recorded numbers drift again as soon as code changes | Medium | `STATUS.md` is SHA-stamped; any edit without re-running the ladder is a defect |

## Definition of done

- [ ] Task 0 resolved; `npm`, `tsc`, `eslint`, `vitest`, `playwright` runnable
- [ ] Task 1 ladder run with **real** output recorded per command, per Playwright project
- [ ] Task 2 merged: offline score caching works when enabled, is provably off for
      unentitled members, and is covered by tests that fail if the guard is removed
- [ ] Task 3 merged: zero `as LLMProviderValue` / `as 'header' | 'full' | 'both'` casts remain;
      bad settings warn and fall back; decrypt failure is observable and never logs a key
- [ ] Task 4 deferral recorded with its full technical justification
- [ ] Task 5: one SHA-stamped `STATUS.md`; ten reports in `docs/archive/`; stub at each
      original root path; no document claims an unrun gate passed
- [ ] Task 6 ladder green, `--project=stand` included
- [ ] External gates listed as **not validated**, not as passed

## Open questions for the user

1. **Task 0** — will you grant `npm`/`tsc`/`eslint`/`vitest`/`playwright` bash permission,
   or run the ladder yourself and paste output? Everything else is blocked on this.
2. **Archive location** — `docs/archive/` is assumed; confirm, or name a different path.
