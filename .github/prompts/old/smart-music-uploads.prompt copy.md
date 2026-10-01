I unpacked and reviewed the uploaded repo (`eccb.app-main`). It’s a Next.js app with Prisma (MariaDB), BullMQ/Redis job infrastructure, and a dual LOCAL/S3 storage layer. Music uploads currently live mostly in:

* `src/app/(admin)/admin/music/actions.ts` (server actions)
* `src/components/admin/music/*` (forms + file list UI)
* `src/app/api/files/upload/route.ts` (a separate, more “secure” upload API route)
* `src/lib/jobs/*` + `src/workers/*` (queue + workers)
* `prisma/schema.prisma` (MusicPiece/MusicFile/MusicPart)

Also: the doc you referenced (`docs/SMART_UPLOAD_INTEGRATION_PROMPT.md`) is **not present** in the zip, so it should be created as part of the work.

Below is an **exhaustive, end-to-end file checklist** for a fully integrated Smart Upload feature **including** a provider-agnostic LLM layer that supports:

* **Local/self-hosted** via **OpenAI-compatible** endpoints (Ollama/vLLM/TGI/LM Studio/etc.) ([Ollama Docs][1])
* **OpenRouter** (OpenAI-compatible) ([OpenRouter][2])
* **Gemini**, **OpenAI**, **Anthropic** (first-class adapters)
* **KiloCode Gateway** (OpenAI-compatible base URL per their docs) ([Kilo][3])
* **OpenCode** compatibility by supporting the same “many providers via config/AI-SDK style provider abstraction” approach ([OpenCode][4])
* Plus “all major providers” either as first-class adapters **or** via OpenAI-compatible/gateway routing (Together, Groq, Fireworks, Perplexity, DeepSeek, Mistral, Cohere, etc.)

---

## 1) Database + Prisma (required)

### UPDATE

* `prisma/schema.prisma`
  Add Smart Upload persistence + music-file enhancements. Typical additions:

  * `MusicFile.contentHash` (dedupe)
  * `MusicFile.source` / `ingestedFrom` / `originalUploadId` (traceability)
  * `MusicFile.ocrText` (optional) or separate table if large
  * `MusicFile.extractedMetadata` (JSON) + `extractionConfidence`
  * New models:

    * `SmartUploadBatch` (tracks a multi-file smart upload session)
    * `SmartUploadItem` (each file in the batch + per-file status)
    * Optionally `SmartUploadProposal` (the “LLM-suggested” MusicPiece + parts mapping)
  * Enums:

    * `SmartUploadStatus` (QUEUED/RUNNING/NEEDS_REVIEW/APPROVED/INGESTED/FAILED/CANCELLED)
    * `SmartUploadStep` (OCR/LLM/PDF_SPLIT/INGEST/etc.)

### CREATE

* `prisma/migrations/<timestamp>_smart_upload/...`
  Generated migration adding the schema above.

### UPDATE

* `prisma/seed.ts`
  Seed any new permissions (see §2), and (if you add them) seed default “Smart Upload settings” rows.

---

## 2) Permissions + RBAC (required)

### UPDATE

* `src/lib/auth/permission-constants.ts`
  Add e.g.:

  * `MUSIC_SMART_UPLOAD = 'music.smart_upload'`
  * `MUSIC_SMART_UPLOAD_APPROVE = 'music.smart_upload.approve'` (if review/approve step exists)
    Update the `Permission` union type accordingly.

### UPDATE

* `PERMISSIONS.md`
  Add the new permissions into the matrix and role recommendations (Librarian/Admin/etc.).

---

## 3) Environment + Setup UX (required)

### UPDATE

* `src/lib/env.ts`
  Add typed env vars for Smart Upload + AI providers + OCR/PDF tooling, e.g.:

  * `SMART_UPLOAD_ENABLED`
  * `SMART_UPLOAD_AI_PROVIDER` (enum)
  * `SMART_UPLOAD_MODEL`
  * Provider keys:

    * `OPENAI_API_KEY`
    * `ANTHROPIC_API_KEY`
    * `GEMINI_API_KEY`
    * `OPENROUTER_API_KEY`
    * `KILO_API_KEY`
    * `OPENAI_COMPAT_BASE_URL` (for local/self-hosted/custom)
    * `OPENAI_COMPAT_API_KEY` (optional/dummy for local)
  * OCR config:

    * `SMART_UPLOAD_OCR_MODE` (`pdf_text` | `tesseract` | `ocrmypdf` | `vision_api`)
  * Limits:

    * `SMART_UPLOAD_MAX_FILES`, `SMART_UPLOAD_MAX_TOTAL_MB`, etc.

### UPDATE

* `env.example`
  Add the new env vars with safe placeholders.

### UPDATE

* `src/lib/setup/env-manager.ts`
  Add new variables + categories (“AI / LLM”, “SMART UPLOAD”, “OCR”) so your setup tooling can generate `.env` and `.env.example`.

### UPDATE (optional but recommended if you rely on server packages)

* `scripts/deploy-setup.sh`
  Install OCR/PDF tools (e.g., `tesseract-ocr`, `poppler-utils`, `qpdf`, `ghostscript`) if your OCR/splitting approach uses system binaries.

---

## 4) Package/dependency surface (required)

### UPDATE

* `package.json`
  Add dependencies for:

  * PDF splitting/manipulation (e.g., `pdf-lib` or similar)
  * Text extraction (e.g., `pdf-parse` or `pdfjs-dist`)
  * OCR (Node OCR lib *or* wrappers around system tools)
  * LLM SDKs or a unified abstraction layer:

    * OpenAI SDK
    * Anthropic SDK
    * Gemini/Google GenAI SDK
    * (Or a single “provider-agnostic” layer and just adapters)
  * Robust JSON parsing/validation (you already use `zod` widely)

### UPDATE

* `package-lock.json`
  Auto-updated by npm.

---

## 5) LLM Provider Abstraction Layer (required to meet your provider list)

> This is the key to “OpenRouter + local + OpenAI + Anthropic + Gemini + KiloCode + OpenCode + others” without hardcoding dozens of one-off call sites.

### CREATE (new folder)

* `src/lib/ai/types.ts`
  Common types (`AIProviderId`, `ChatModelRequest`, `StructuredExtractionResult`, retry policy, etc.)

* `src/lib/ai/provider-registry.ts`
  Reads env, returns a provider client instance, enforces model/provider compatibility, centralizes headers, timeouts, retries.

* `src/lib/ai/index.ts`
  Public entrypoint used by Smart Upload jobs: `extractMusicMetadata(...)`, `classifyParts(...)`, etc.

### CREATE (providers)

* `src/lib/ai/providers/openai.ts`
  First-class OpenAI integration.

* `src/lib/ai/providers/anthropic.ts`
  First-class Anthropic integration.

* `src/lib/ai/providers/gemini.ts`
  First-class Gemini integration.

* `src/lib/ai/providers/openai-compatible.ts`
  **The most important adapter**: supports any OpenAI-compatible base URL. This covers:

  * **Local/self-hosted** (e.g., Ollama exposes OpenAI-compatible endpoints) ([Ollama Docs][1])
  * **OpenRouter** ([OpenRouter][2])
  * **KiloCode Gateway** ([Kilo][3])
  * “Other major providers” that expose OpenAI-compatible APIs
  * “OpenCode Zen / custom gateways” when you have a base URL + key (OpenCode’s ecosystem leans on a provider-agnostic approach) ([OpenCode][4])

### CREATE (thin convenience wrappers, optional but nice)

* `src/lib/ai/providers/openrouter.ts`
  Calls into `openai-compatible` with OpenRouter defaults + headers.

* `src/lib/ai/providers/kilo.ts`
  Calls into `openai-compatible` with Kilo gateway defaults. ([Kilo][3])

* `src/lib/ai/providers/custom.ts`
  Lets you define additional providers purely from env (base URL + headers), so you don’t need code changes for “the next provider”.

### CREATE (prompts + schemas)

* `src/lib/ai/prompts/music-metadata.ts`
  Prompt template(s) for extracting: title/composer/arranger/difficulty/catalogNo/publisher, etc.

* `src/lib/ai/prompts/part-classification.ts`
  Prompt + schema for mapping pages/files to instruments/parts.

* `src/lib/ai/structured-output.ts`
  Shared JSON extraction helpers (repair, validate with zod, recover from partial outputs).

---

## 6) Smart Upload Pipeline (OCR → LLM → split → ingest) (required)

### CREATE

* `src/lib/services/smart-upload/smart-upload.types.ts`
  Shared types: batch, item, statuses, job payloads.

* `src/lib/services/smart-upload/smart-upload.service.ts`
  Orchestrator helpers:

  * create batch
  * attach files
  * advance status
  * persist extracted metadata/proposals
  * finalize ingestion (create MusicPiece/MusicFile/MusicPart)
  * rollback/cancel logic

* `src/lib/services/smart-upload/text-extraction.ts`
  PDF text extraction + OCR fallback.

* `src/lib/services/smart-upload/pdf-splitter.ts`
  Splitting PDFs into per-part files (or per-instrument bundles), writes back to storage.

* `src/lib/services/smart-upload/content-hash.ts`
  Hashing for dedupe/idempotency.

* `src/lib/services/smart-upload/instrument-mapper.ts`
  Maps LLM strings → existing `Instrument` rows (fuzzy matching + safe fallback).

* `src/lib/services/smart-upload/validators.ts`
  Limits, file type checks, “dangerous PDF” checks, etc.

### UPDATE (recommended so Smart Upload can reuse consistent library behavior)

* `src/lib/services/music.service.ts`
  Add ingestion helpers so both manual and smart flows share the same “create piece / attach files / create parts / audit-log / invalidate cache” code paths.

### UPDATE (if you want consistent file validation everywhere)

* `src/lib/services/storage.ts`
  Expose/reuse magic-byte validation utilities for *server actions* too (currently the API route does more robust validation than `actions.ts`).

---

## 7) Job Queue + Workers (required)

### UPDATE

* `src/lib/jobs/definitions.ts`
  Add job types and queue config, e.g.:

  * `smartUpload.createBatch`
  * `smartUpload.extractText`
  * `smartUpload.llmExtractMetadata`
  * `smartUpload.classifyParts`
  * `smartUpload.splitPdf`
  * `smartUpload.ingest`
  * `smartUpload.cleanup`
    Add a new queue name like `SMART_UPLOAD` (or `AI`) with its concurrency + retry policy.

### UPDATE

* `src/lib/jobs/queue.ts`
  Register the new queue:

  * add to `QueueInstances` and `queues`
  * ensure `getAllQueueStats()` includes it
  * ensure dead-letter behavior works

### CREATE

* `src/workers/smart-upload-worker.ts`
  Worker that processes the new Smart Upload jobs (and updates BullMQ progress + DB status).

### UPDATE

* `src/workers/index.ts`
  Start the smart upload worker alongside email/scheduler.

### UPDATE (monitoring API must know the new queue)

* `src/app/api/admin/jobs/route.ts`
  Extend queue-name zod enums and logic so admin monitoring can view/retry smart-upload jobs.

---

## 8) API Routes (required)

### CREATE

* `src/app/api/music/smart-upload/route.ts`

  * `POST`: initiate a batch (metadata + permissions + CSRF)
  * optionally `GET`: list recent batches for the current user

### CREATE

* `src/app/api/music/smart-upload/[batchId]/route.ts`

  * `GET`: batch details, status, extracted proposal, job IDs, errors
  * `PATCH`: update batch (rename, set notes, etc.)

### CREATE (if you have approve/review step)

* `src/app/api/music/smart-upload/[batchId]/approve/route.ts`

  * `POST`: approve proposal and enqueue ingestion

### CREATE (optional but useful)

* `src/app/api/music/smart-upload/[batchId]/cancel/route.ts`

  * `POST`: cancel batch + attempt job cancellation/cleanup

> If you prefer to keep everything as server actions, you can do that—BUT you’ll still want API routes for polling progress from the client cleanly.

---

## 9) Admin UI + Client Hooks (required)

### CREATE

* `src/app/(admin)/admin/music/smart-upload/page.tsx`
  Main Smart Upload page (dropzone + provider/model shown + limits + start upload).

### CREATE

* `src/app/(admin)/admin/music/smart-upload/[batchId]/page.tsx`
  Review/progress page:

  * progress timeline (OCR → LLM → split → ingest)
  * extracted fields preview (editable)
  * proposed part mapping
  * approve/ingest or fix+retry

### UPDATE (add entry point so it’s “integrated into the app”)

* `src/components/admin/sidebar.tsx`
  Add a “Smart Upload” item under Music Library.

### UPDATE (optional but recommended UX)

* `src/app/(admin)/admin/music/page.tsx`
  Add a “Smart Upload” CTA button near “Add New Piece”.

### CREATE

* `src/components/admin/music/smart-upload/smart-upload-dropzone.tsx`
  Multi-file uploader (progress per file before server submit).

* `src/components/admin/music/smart-upload/smart-upload-progress.tsx`
  Polls batch/job status and renders steps.

* `src/components/admin/music/smart-upload/smart-upload-review-form.tsx`
  Shows extracted metadata + validation.

* `src/components/admin/music/smart-upload/part-mapping-editor.tsx`
  Allows fixing instrument mapping before ingest.

### CREATE (hooks)

* `src/hooks/use-smart-upload.ts`
  Client hook for:

  * create batch
  * upload files
  * poll batch status
  * approve/cancel

### UPDATE (if you reuse existing upload UI patterns)

* `src/components/admin/music/music-form.tsx`
  Add “Use Smart Upload instead” entry point, or a link to the new page.

---

## 10) Server Actions (required if you want the admin pages to stay consistent with the app’s patterns)

### UPDATE

* `src/app/(admin)/admin/music/actions.ts`
  Add server actions wrapping the new APIs/services, e.g.:

  * `createSmartUploadBatch()`
  * `addFilesToSmartUploadBatch()`
  * `approveSmartUploadBatch()`
  * `cancelSmartUploadBatch()`
  * `getSmartUploadBatch()` / list batches

(Or, if you prefer, put these in a new file:)

### CREATE (optional)

* `src/app/(admin)/admin/music/smart-upload/actions.ts`

---

## 11) Tests (required for “completely integrated”)

### CREATE

* `src/lib/services/__tests__/smart-upload.service.test.ts`
  Covers:

  * batch lifecycle
  * dedupe/idempotency
  * mapping logic
  * ingestion writes correct MusicPiece/MusicFile/MusicPart

### CREATE

* `src/lib/ai/__tests__/provider-registry.test.ts`
  Ensures:

  * env selection works
  * provider fallbacks
  * OpenAI-compatible base URL logic

### CREATE

* `src/workers/__tests__/smart-upload-worker.test.ts`
  Job processing with mocks for OCR/LLM/PDF splitting.

### UPDATE (as needed)

* Existing music tests if you add new required fields or change ingestion behavior:

  * `src/lib/services/__tests__/music.service.test.ts`

---

## 12) Documentation (required)

### CREATE

* `docs/SMART_UPLOAD_INTEGRATION_PROMPT.md`
  The “complete integration prompt” you referenced (currently missing).

### CREATE

* `docs/SMART_UPLOAD.md`
  Operator/dev docs:

  * how to use
  * how approval works
  * failure modes + retry

### CREATE

* `docs/AI_PROVIDERS.md`
  How to configure:

  * OpenAI / Anthropic / Gemini
  * OpenRouter ([OpenRouter][2])
  * Kilo gateway ([Kilo][3])
  * Local Ollama/vLLM/etc via OpenAI-compatible ([Ollama Docs][1])
  * Custom gateways (base URL + key)

### UPDATE (recommended)

* `README.md`
  Add Smart Upload setup section + required env vars + worker requirements.

---

## 13) “Gotchas” you should treat as required integration points

These map directly to files above, but I’m calling them out because they’re the usual “feature isn’t really integrated” failure modes:

* **Job monitoring** must include the new queue (`src/app/api/admin/jobs/route.ts`, `src/lib/jobs/*`)
* **Permissions** must gate *every* entry point: API routes + pages + actions
* **Workers** must run in prod (your process manager spawns `src/workers/index.ts`, so it must start the smart worker)
* **Storage** must support the new derived artifacts (split PDFs) consistently for LOCAL and S3
* **Idempotency** (contentHash) prevents duplicate ingest when retries happen

---

If you want, I can also output a **second version** of this list that’s “minimum viable Smart Upload” (single orchestrator job, no approval UI, fewer tables) vs “enterprise-grade Smart Upload” (review/approve/rollback, partial retries, per-step artifacts).

[1]: https://docs.ollama.com/api/openai-compatibility "https://docs.ollama.com/api/openai-compatibility"
[2]: https://openrouter.ai/docs/quickstart "https://openrouter.ai/docs/quickstart"
[3]: https://kilo.ai/docs/gateway "https://kilo.ai/docs/gateway"
[4]: https://opencode.ai/docs/providers/ "https://opencode.ai/docs/providers/"
