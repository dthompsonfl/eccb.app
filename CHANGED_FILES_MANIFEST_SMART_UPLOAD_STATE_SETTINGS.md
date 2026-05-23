# Smart Upload State Visibility and Settings Canonicality - Changed Files Manifest

Generated: 2026-05-23
Scope: Modified/created files only. This package does not contain the full repository.

## Summary

This patch fixes the Smart Upload -> Music Review visibility gap and establishes a canonical runtime settings facade for Smart Upload behavior.

## Created files

| Path | Reason | Validation coverage |
| --- | --- | --- |
| `src/lib/smart-upload/runtime-config.ts` | Canonical Smart Upload runtime settings facade. Runtime callers should load Smart Upload config and settings snapshots from this module instead of reading scattered DB/env/provider sources directly. | TypeScript transpile check |
| `src/lib/smart-upload/__tests__/review-visibility.test.ts` | Regression coverage for actionable review statuses and filter grouping. | TypeScript transpile check |
| `src/lib/smart-upload/__tests__/runtime-config.test.ts` | Regression coverage for SystemSetting-backed settings snapshots and stable hashes. | TypeScript transpile check |
| `docs/smart-upload/SMART_UPLOAD_STATE_AND_SETTINGS_CANONICALITY.md` | Operational and developer documentation for the new visibility and canonical settings contract. | Documentation review |
| `CHANGED_FILES_MANIFEST_SMART_UPLOAD_STATE_SETTINGS.md` | Manifest for this modified-files-only delivery package. | Manual review |
| `IMPLEMENTATION_REPORT_SMART_UPLOAD_STATE_SETTINGS.md` | Implementation report and validation evidence for this delivery package. | Manual review |

## Modified files

| Path | Reason | Validation coverage |
| --- | --- | --- |
| `src/lib/smart-upload/state.ts` | Added canonical review status groupings, filters, and helper predicates so Music Review can show actionable uploads rather than only `REQUIRES_REVIEW`. | TypeScript transpile check; review visibility tests added |
| `src/app/api/admin/uploads/review/route.ts` | Changed default review API behavior from `REQUIRES_REVIEW` only to actionable statuses; added filter support, focused session loading, and expanded stats. | TypeScript transpile check |
| `src/app/(admin)/admin/uploads/review/page.tsx` | Added review visibility filters, actionable/processing/failed stats, safer bulk-selection eligibility, and a clearer empty state. | TypeScript transpile check |
| `src/app/api/admin/uploads/status/[sessionId]/route.ts` | Added review visibility metadata and direct focused review URL to upload status responses. | TypeScript transpile check |
| `src/app/api/admin/uploads/settings/route.ts` | Added canonical settings source metadata to GET/PUT responses and snapshot reporting. | TypeScript transpile check |
| `src/app/api/files/smart-upload/route.ts` | Routes uploads through canonical Smart Upload runtime config, captures settings snapshot provenance, and marks queue enqueue failures as review-visible failed sessions. | TypeScript transpile check |
| `src/workers/smart-upload-processor.ts` | Captures settings snapshot provenance, makes processing failures top-level `FAILED`, routes second-pass/gap states to review-visible status, and prevents invisible stuck uploads. | TypeScript transpile check |
| `src/workers/smart-upload-worker.ts` | Captures settings snapshot provenance for second pass, updates terminal second-pass failure visibility, and finalizes review/autonomous status consistently. | TypeScript transpile check |
| `src/workers/smart-upload-processor-worker.ts` | Uses canonical Smart Upload runtime config facade. | TypeScript transpile check |
| `src/workers/ocr-worker.ts` | Uses canonical Smart Upload runtime config facade. | TypeScript transpile check |
| `src/lib/services/page-labeler.ts` | Uses canonical Smart Upload runtime config facade for header-label processing. | TypeScript transpile check |
| `src/app/api/stand/omr/route.ts` | Uses canonical Smart Upload runtime config facade for OMR model configuration. | TypeScript transpile check |
| `src/lib/smart-upload/commit.ts` | Marks failed commit attempts as review-visible failed sessions and tightens transaction typing. | TypeScript transpile check |
| `src/app/api/files/smart-upload/__tests__/route.test.ts` | Updated mocks for the canonical runtime config facade. | TypeScript transpile check |
| `src/app/api/files/smart-upload/__tests__/integration.test.ts` | Updated mocks for the canonical runtime config facade. | TypeScript transpile check |
| `src/workers/__tests__/quality-gates.test.ts` | Updated mocks for the canonical runtime config facade. | TypeScript transpile check |
| `src/workers/__tests__/regression.test.ts` | Updated mocks for the canonical runtime config facade. | TypeScript transpile check |
| `src/workers/__tests__/smart-upload-processor.test.ts` | Updated imports/mocks for the canonical runtime config facade. | TypeScript transpile check |
| `src/workers/__tests__/smart-upload-second-pass.test.ts` | Updated imports/mocks for the canonical runtime config facade. | TypeScript transpile check |
| `src/lib/services/__tests__/page-labeler.test.ts` | Updated mocks for the canonical runtime config facade. | TypeScript transpile check |
| `src/app/api/stand/omr/__tests__/route.test.ts` | Updated mocks for the canonical runtime config facade. | TypeScript transpile check |

## Not included

This package intentionally does not include the entire codebase. It only includes files created or modified during this session.
