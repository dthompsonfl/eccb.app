# Smart Upload State Visibility and Settings Canonicality - Implementation Report

Generated: 2026-05-23
Repository archive: `eccb.app-main (5).zip`
Delivery type: modified/created files only

## Objective

Fix the Smart Upload -> Music Review pipeline so uploaded music sessions remain visible and actionable even when workers are unavailable, queues fail, parsing fails, second pass is queued, or commit fails. Establish one canonical runtime settings access layer for Smart Upload behavior.

## Current-state findings addressed

- Music Review defaulted to a narrow `REQUIRES_REVIEW` view and could hide `PROCESSING`, `FAILED`, `AUTO_COMMITTING`, `AUTO_COMMITTED`, and `PENDING_REVIEW` sessions.
- Queue enqueue failure could leave a session in `PROCESSING` with `parseStatus: PARSE_FAILED`, making it look like the upload vanished.
- Worker failure branches could set parse failure without making the top-level session status review-visible.
- Runtime settings were accessed through `src/lib/llm/config-loader.ts` from multiple feature surfaces instead of a Smart Upload-owned canonical module.
- Settings provenance was not captured on upload/worker session writes, making it hard to know which effective settings governed a session.

## Changes made

### State visibility

- Added review status groupings in `src/lib/smart-upload/state.ts`.
- Changed the review API default from a single `REQUIRES_REVIEW` status to an actionable status group.
- Added review filters for actionable, needs review, processing, failed, approved, rejected, and all.
- Added focused review session behavior that still loads any session state by `sessionId`.
- Added direct review visibility metadata to upload status responses.
- Restricted bulk selection to sessions that are actually approvable or rejectable.

### Failure-state handling

- Queue enqueue failure now marks sessions as `FAILED`, `PARSE_FAILED`, `secondPassStatus: FAILED`, and `requiresHumanReview: true`.
- Processor failure branches now mark top-level status as `FAILED` instead of leaving sessions invisible in `PROCESSING`.
- Second-pass queued and gap-detected paths now become review-visible through `REQUIRES_REVIEW`.
- Commit failures now mark sessions as `FAILED` and `requiresHumanReview: true` while preserving commit error details.

### Settings canonicality

- Added `src/lib/smart-upload/runtime-config.ts` as the Smart Upload-owned runtime configuration facade.
- Runtime Smart Upload consumers now import from that facade instead of directly importing `src/lib/llm/config-loader.ts`.
- The canonical persistence source is documented as `SystemSetting` for this codebase.
- The `SmartUploadSetting` Prisma model is documented as legacy/deprecated until a dedicated migration removes or reactivates it.
- Uploads and workers now capture a settings snapshot summary in `llmModelParams.smartUploadSettings`.
- The Smart Upload settings API now reports canonical source metadata.

### Tests and docs

- Added review visibility tests.
- Added runtime config snapshot tests.
- Updated affected test mocks to mock the same runtime facade used by production code.
- Added a Smart Upload state/settings canonicality documentation page.

## Validation performed

| Check | Outcome | Notes |
| --- | --- | --- |
| Modified-file TypeScript transpile check | Passed | Checked every changed TS/TSX file with the globally available TypeScript transpiler. |
| `git diff --no-index --check` | Passed | No whitespace errors or conflict markers found between original and patched trees. |
| `npm run lint -- --quiet` | Not runnable in this environment | Failed because `eslint` is not installed; uploaded archive does not include `node_modules`. |
| `tsc --noEmit --pretty false` | Environment-blocked | Fails broadly because dependencies and types such as Next, Prisma, React, Playwright, Node types, and BullMQ are not installed. Changed files were checked with a targeted transpile check. |

## Required local validation after applying

Run these locally from the real repository with dependencies installed:

```bash
npm install
npm run lint
npx tsc --noEmit
npm run build
npm test -- --run src/lib/smart-upload/__tests__/review-visibility.test.ts src/lib/smart-upload/__tests__/runtime-config.test.ts
```

Then manually verify:

1. Upload a music PDF through `/admin/uploads`.
2. Start the Smart Upload worker process.
3. Confirm `/admin/uploads/review` shows the upload under Actionable or Processing immediately.
4. Stop the worker and upload another PDF; confirm the session remains visible/actionable rather than disappearing.
5. Force or simulate queue enqueue failure and confirm the review API reports the session as failed/reviewable.
6. Open `/admin/uploads/review?sessionId=<sessionId>` and confirm the exact session loads regardless of status.
7. Confirm Settings API responses include canonical source metadata.

## Known limitations

- This patch does not rewrite OCR or segmentation algorithms. It fixes the state visibility and settings canonicality foundation required before autonomous parsing can be made trustworthy.
- Full lint/typecheck/build could not be executed in this environment because dependencies were not installed in the uploaded archive.
- `SmartUploadSetting` is documented as deprecated, but this patch does not remove the Prisma model. Removing or migrating it should be a separate schema migration.

## Release-risk notes

- The review queue will now show more sessions by default. This is intentional; operators should see processing and failed sessions rather than an empty queue.
- Upload route config loading is intentionally stricter: Smart Upload runtime settings must load from the canonical facade. This prevents silent drift between settings UI and runtime behavior.
- Failed processing/commit sessions are now visible for review and recovery instead of remaining hidden in processing states.
