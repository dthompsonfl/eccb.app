# Smart Upload State Visibility and Settings Canonicality

## Purpose

This document records the implementation contract for the Smart Upload -> Music Review pipeline.

## Review visibility contract

The Music Review page must not hide a Smart Upload session simply because processing has not completed yet. The default review queue uses the `ACTIONABLE` status group:

- `PROCESSING`
- `AUTO_COMMITTING`
- `REQUIRES_REVIEW`
- `FAILED`
- `PENDING_REVIEW` legacy compatibility

Operators can filter by:

- Actionable
- Needs Review
- Processing
- Failed
- Approved
- Rejected
- All

Focused review URLs must continue to open any session state:

```txt
/admin/uploads/review?sessionId=<uploadSessionId>
```

## Failure-state contract

A Smart Upload processing path must never fail by updating only `parseStatus` or `secondPassStatus` while leaving the top-level `SmartUploadSession.status` as `PROCESSING`.

Failure outcomes must set a review-visible top-level status:

- `FAILED` for queue, validation, rendering, split, unhandled processor, second-pass, or commit failures.
- `REQUIRES_REVIEW` for recoverable ambiguity or human decision paths.

Required fields for failed sessions:

- `status: FAILED`
- `requiresHumanReview: true`
- detailed sub-status where applicable, such as `parseStatus: PARSE_FAILED` or `secondPassStatus: FAILED`
- `routingDecision` or `commitError` explaining the failure

## Canonical settings source

Smart Upload runtime behavior is loaded through:

```ts
src/lib/smart-upload/runtime-config.ts
```

That facade is the only approved Smart Upload runtime settings entry point for upload routes, processors, OCR workers, page labelers, and review-adjacent services.

Current storage decision:

- Canonical persistence table: `SystemSetting`
- Deprecated/legacy table: `SmartUploadSetting`

The `SmartUploadSetting` Prisma model remains in the schema for backward compatibility, but it is not the runtime source of truth. Do not add new runtime reads from that model.

## Settings snapshot provenance

Each new upload session captures a Smart Upload settings snapshot summary in `llmModelParams.smartUploadSettings`:

- source
- schema
- hash
- capturedAt
- keys used

Workers preserve this provenance in subsequent session updates.

## Local verification

Run these checks after changing this feature:

```bash
npm run lint
npx tsc --noEmit
npm run test:run -- src/lib/smart-upload/__tests__/review-visibility.test.ts src/lib/smart-upload/__tests__/runtime-config.test.ts
npm run build
```

Then manually verify:

1. Start the web app and Smart Upload worker.
2. Upload a valid PDF.
3. Open `/admin/uploads/review` immediately.
4. Confirm the upload appears under Actionable while processing.
5. Stop Redis/worker or force a queue failure in a local test environment.
6. Confirm the failed session appears under Failed and the focused URL still opens it.
7. Confirm `/admin/uploads/settings` returns `canonicalSource.source = SystemSetting`.
