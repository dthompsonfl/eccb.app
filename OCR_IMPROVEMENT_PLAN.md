# OCR Improvement Plan (Exhaustive File-by-File Checklist)

This document describes **every file that must be created or updated** in order to implement the stronger, fully‑autonomous OCR pipeline outlined by the user.  Changes are grouped by area but the list is complete – nothing is left to guess.  All smart‑upload configuration is driven from the database and exposed through the browser UI.

> **Status:**  As of Phase 7 the work described below has been implemented in the codebase.  This file now serves as a permanent record of what was changed; future phases may update or prune items as needed. 

## Legend
- ✓ = Implemented
- ❌ = Not yet implemented
- ⚠️ = Partially implemented

---

## 1. Core services

### `src/lib/services/ocr-fallback.ts`
- Add new `ocrMode`/`ocrEngine` parameter taken from DB/env (`pdf_text`, `tesseract`, `ocrmypdf`, `vision_api`).
- Implement utility wrappers:
  - `runOcrmypdf(buffer): Promise<Buffer>` – spawn `ocrmypdf` (native binary) to produce a searchable PDF; return buffer or throw.
  - `callVisionApi(base64): Promise<string>` – send image(s) to a configured cloud vision provider and return extracted text.
  - Refactor `tryOcrBase64ImageToText()` into generic `tryOcrEngine(base64, options)` supporting engine selection and Tesseract CLI options (`--psm`, `--oem`, whitelist, traineddata path).
- Add a preprocess stage that, when `ocrMode==="ocrmypdf"` or `ocrEngine==="native"`, runs the PDF through OCR before the text‑layer probe.
- Extend text‑layer probe to incrementally scan pages up to `maxTextProbePages` or until text found; make probe count configurable by new setting `smart_upload_ocr_max_pages`.
- Improve logging:
  - Log when OCR returns zero characters or low‑confidence.
  - Log which engine/mode was used.
- Optionally persist raw OCR text when `smart_upload_store_raw_ocr_text` is true (new DB key) – this requires writing to a new column or separate table.
- Add appropriate TypeScript types and update exports (`ocrMode` type, new helper functions).

### `src/lib/services/header-image-segmentation.ts`
- Make constants (`DEFAULT_CROP_HEIGHT`, `DEFAULT_HASH_THRESHOLD`, `fallbackCropFractions`) driveable from options or runtime config loaded from DB via `llmConfig`/`ocrConfig`.
- Add new options: `hashDistanceThreshold`, `hashWidth`, `hashHeight`, `cropHeightFractions`.
- Extend `preprocessForOcr()` with advanced steps: deskew (using `sharp.skew()` or OpenCV via [`opencv4nodejs`]), binarisation (`threshold()`), morphological opening/closing to remove noise, bleed‑through removal; document that `ocrmypdf --clean` could be used as alternative.
- Add additional cropping logic for two‑column headers or clef detection (placeholder comment or simple heuristic).
- Add detailed diagnostics logging for:
  - hash distances on every page (including when all distances < threshold)
  - OCR attempts with no text, low confidence, or engine used
  - segments that fell back to "Part N".
- Adjust unit tests (`src/lib/services/__tests__/header-image-segmentation.test.ts`) to cover new options and preprocess behaviour.

### `src/lib/services/pdf-text-extractor.ts`
- Change `maxPages` parameter to be configurable (previously a function argument) and add an overload that probes until it finds at least one page with header text or until a DB limit.
- Add methods to normalise common OCR noise (e.g. replace `I`/`l`, remove non‑printing characters) before passing text to the parser.

### `src/lib/services/page-labeler.ts` *(new file)*
- Create from scratch according to enterprise checklist:
  1. Accept `{ pdfBuffer, pageCount, pageIndices, mode }` and optional budget / config.
  2. Strategy priority:
     - Text‑layer header extraction → deterministic parse (reuse functions from `pdf-text-extractor` and `ocr-fallback.extractTitleComposerFromText`).
     - OCR header crop (using new `ocr-fallback` engines) → deterministic parse.
     - Fallback to LLM header‑label prompt, enforcing page/batch/token budgets via settings `smart_upload_llm_max_pages` and `smart_upload_llm_max_header_batches`.
  3. Output per‑page `{ label, confidence, source: 'text'|'ocr'|'llm' }` and overall confidence.
- Expose helper for `smart-upload-processor.ts` to consume.
- Add unit tests exercising each branch and budget behaviour.

## 2. Worker code

### `src/workers/ocr-worker.ts`
- Read new DB settings via `loadSmartUploadRuntimeConfig()` (see config-loader updates below).
- Use `SMART_UPLOAD_OCR_MODE`/`ocrMode` value or config to choose engine path; dispatch to `ocr-fallback` accordingly.
- When engine is `ocrmypdf`, run the raw PDF through `runOcrmypdf()` before passing buffer to `extractOcrFallbackMetadata()`.
- Add optional storage of raw OCR text: if `config.storeRawOcrText` true, include a new field `rawOcrText` in `smartUploadSession` or a new table and update the schema.
- Increase default `OCR_WORKER_RPM`/`OCR_WORKER_CONCURRENCY` to read from settings (e.g. `smart_upload_ocr_rate_limit`), and document how to bump them via admin UI.
- Add caching support for rendered crops – add simple LRU in worker or mark `renderPdfHeaderCropBatch` with `cacheTag=sessionId` so repeated OCR jobs reuse images.
- Update existing tests for ocr-worker accordingly.

## 3. Pipeline & processor

### `src/workers/smart-upload-processor.ts`
- Modify `ocrFirstEligible` computation to respect new setting `smart_upload_enable_ocr_first` and to use `smart_upload_skip_parse_threshold` and `smart_upload_text_layer_threshold_pct`.
- When deterministic segmentation is low‑confidence but text layer coverage ≥ threshold, call `extractTitleComposerFromText()` directly and skip LLM.
- Insert call to `page-labeler` for multi‑page labeling instead of current header‑crop LLM loop; pass configuration values for text/ocr/llm budgets.
- Expose new configuration values (`ocrMaxPages`, `ocrMode`, `textProbePages`) from loaded runtime config and feed them into `extractOcrFallbackMetadata()` and `segmentByHeaderImages()`.
- After `extractOcrFallbackMetadata`, record `ocrEngine` and any preprocessing choices in session metadata for auditing.
- Add logging when the pipeline decides to escalate to LLM citing exactly which criteria failed.
- Add optional stage to re‑probe later pages if first few pages yielded no useful text and `smart_upload_text_probe_pages` > 3.
- Add new unit/integration tests for the OCR‑first path (existing tests already cover some flows, expand them to include new settings). 

## 4. Configuration & DB schema

### `src/lib/smart-upload/schema.ts` (modify)
- Add the following keys to `SMART_UPLOAD_SETTING_KEYS` and to the Zod schema with appropriate defaults/validators:
  - `smart_upload_enable_ocr_first`: boolean, default `true`.
  - `smart_upload_text_layer_threshold_pct`: number 0–100, default `40`.
  - `smart_upload_ocr_mode`: enum `'header'|'full'|'both'` (corresponds to `OCRFallbackOptions.ocrMode`).
  - `smart_upload_ocr_max_pages`: number, default `3`.
  - `smart_upload_llm_max_pages`: number, default `10`.
  - `smart_upload_llm_max_header_batches`: number, default `2`.
  - `smart_upload_store_raw_ocr_text`: boolean, default `false`.
  - `smart_upload_ocr_engine`: enum `'tesseract'|'ocrmypdf'|'native'`, default `'tesseract'`.
  (`'vision_api'` was retired: it had no implementation and returned empty OCR.)
  - `smart_upload_ocr_rate_limit_rpm`: number, default `6`.
  - `smart_upload_text_probe_pages`: number, default `10`.
- Update validation helpers where necessary (e.g. `JSON_KEYS` may need new additions).
- Add corresponding TypeScript types and export them if used elsewhere.

### `src/lib/smart-upload/bootstrap.ts` (modify)
- Add new keys to `DEFAULT_NUMERIC_SETTINGS` and/or `DEFAULT_JSON_SETTINGS` where appropriate:
  - See defaults above.
- Ensure bootstrap seeds the new keys when missing.
- Update the bootstrap unit tests (`src/lib/smart-upload/__tests__/bootstrap.test.ts`) to assert presence of new defaults and to verify new keys do not break existing behaviour.

### `src/lib/llm/config-loader.ts` (modify)
- Extend `LLMRuntimeConfig` with the new OCR settings; read them from `db[...]` with sensible fallbacks (mirror schema defaults).
- Export a helper `loadSmartUploadOcrConfig()` if separation is desirable or simply add fields to existing `loadSmartUploadRuntimeConfig()` output.
- Update any code that constructs `llmConfig` to propagate the new values.

### Migrations (if using Prisma)
- Add new system settings migration if necessary (depends on database type – keys are just rows, so no migration file needed but note in changelog).
- If `rawOcrText` is stored in a column, create a Prisma migration adding that column to `SmartUploadSession` or a new `OcrText` table.  Include the migration in `prisma/migrations/`.

## 5. Admin/UI

### `src/components/admin/music/smart-upload-settings-form.tsx` (modify)
- Add form fields (Switches, Selects, Inputs) for every new setting listed above.
- Update `defaultValues` assignment to read from `settings` record and parse types.
- Add appropriate `FormField`/`FormItem` UI under existing sections (e.g. ``OCR / Local Segmentation`` and ``Budgets``).
- Update validation schema import or handle conversions if necessary (Zod schema already covers new keys).
- Add explanatory `FormDescription` text to guide admins.
- Update any helpers such as `models` or `providerConfig` references if they interact with OCR mode.

### API route tests `src/app/api/admin/uploads/settings/__tests__/route.test.ts` (modify)
- Add test cases verifying that new settings can be retrieved and updated through the API (e.g. enabling/disabling OCR‑first, setting `ocr_mode`).
- If any new keys require JSON validation, add them to `JSON_KEYS` constant and add corresponding test(s).
- Ensure merged settings validation covers the new fields.

## 6. Additional tests and docs

- Add new unit tests for `page-labeler.ts`.
- Add integration tests to `src/app/api/admin/uploads/settings/__tests__` and maybe to the smart upload end‑to‑end tests to exercise the OCR‑first pipeline when the new DB settings are toggled.
- Update existing tests for `ocr-fallback` (`src/lib/services/__tests__/ocr-fallback.test.ts`) to simulate the additional engines, pre‑processing options and raw text storage.
- Add new tests for `header-image-segmentation` option parameters and logging.
- Optionally create tests for `ocr-worker` verifying engine selection and payloads.

## 7. New/modified route files

- `src/app/api/admin/uploads/settings/route.ts`
  - Add any new `JSON_KEYS` entries.
  - No other changes required; the allowed key set is driven by `SMART_UPLOAD_SETTING_KEYS`.

- `src/app/api/admin/uploads/settings/__tests__/route.test.ts` (see above).

## 8. Miscellaneous utilities and documentation

- Update `.env.example` to document the new environment variables (`SMART_UPLOAD_OCR_MODE`, `OCR_*`, etc.) and reflect the OCR engine options.
- Update `DIAGNOSIS.md` or other operational docs with guidance on tuning OCR settings and flags to enable ocrmypdf/vision APIs.
- Add new README sections describing the improved pipeline and how to configure the database settings.

## 9. New files to create

- `src/lib/services/page-labeler.ts` (see above).
- `src/lib/services/ocr-engines.ts` (optional helper to encapsulate engine-specific code).
- New Prisma migration file if `rawOcrText` column/table is required.
- Documentation file `OCR_IMPROVEMENT_PLAN.md` (this file).

## 10. Regression & cleanup

- Review `smart.md` and other project documentation; update or remove outdated comments about unused OCR env keys.
- Audit `lint_full_output.txt` and fix any new lint errors introduced by new code.
- Ensure `tsconfig` and `eslint` rules cover new modules and types.
- Run `npm run test` to surface failing tests and implement missing coverage.

---

**How to proceed**

1. Add the new schema keys and bootstrap defaults first; run migrations if necessary.
2. Update config loader and settings API/UI so the fields are editable.
3. Implement core logic changes in the services (`ocr-fallback`, `header-image-segmentation`, new `page-labeler`).
4. Wire the pipeline in `smart-upload-processor.ts` to use the new services and settings.
5. Expand tests incrementally as features are added; maintain green CI.
6. Deploy and verify improved OCR quality; adjust thresholds via admin UI.

With these modifications in place the system can run **OCR‑first with a configurable, pluggable engine**, send only the truly ambiguous cases to the LLM, and store diagnostics for continuous improvement.  All configuration lives in the database and is exposed through the unified admin settings page.