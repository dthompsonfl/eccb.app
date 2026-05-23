## Plan: Smart Upload Enterprise Completion

Deliver a production-grade, autonomous Smart Upload pipeline that supports combined and multi-PDF uploads, enforces capability-safe vision routing (including OpenRouter vision-only filtering), guarantees deterministic/idempotent ingest into the music library, and hardens install/runtime reliability for OCR on new machines. Keep autonomy behavior settings-driven from Smart Upload admin settings.

**Steps**
1. Phase 0 — Baseline reconciliation and source-of-truth cleanup
   1.1 Audit and reconcile conflicting docs/status artifacts (`SMART_UPLOAD_PRODUCTION_AUDIT.md`, `SMART_UPLOAD_PHASE_1_2_DEPLOYMENT_READINESS.md`, `docs/SMART_UPLOAD_PRODUCTION_READINESS_FINAL.md`, `docs/smart-upload/*`) into a single canonical implementation plan doc in repo docs.
   1.2 Resolve broken doc links/references (`SMART_UPLOAD_SYSTEM_GUIDE.md`, `SMART_UPLOAD_AGENT_GUIDE.md`) and define canonical docs ownership.
   1.3 Produce architecture matrix: intake -> process -> OCR -> second-pass -> commit -> review -> library visibility. *blocks all subsequent work*

2. Phase 1 — Ingest surface and orchestration hardening
   2.1 Extend intake contract to support both combined PDF and multi-PDF packet uploads while preserving current combined-PDF path (idempotent upload sessions + per-file lineage).
   2.2 Finalize queue/worker ownership and stage transitions for process/verify/auto-commit with strict status invariants (no silent fallthrough).
   2.3 Enforce deterministic fail-safe routing for gap/coverage failures and invalid splitting before commit. *depends on 1; partially parallel with 3*

3. Phase 2 — OCR and parsing reliability (new machine readiness)
   3.1 Formalize OCR engine strategy matrix: native text layer -> header/full OCR -> vision fallback; preserve settings-driven toggles (`smart_upload_*`).
   3.2 Add install-time/runtime health checks for OCR capabilities (npm/pnpm install compatibility + system binary probes) and explicit optional-warning behavior.
   3.3 Publish machine bootstrap checklist and verification script outputs for OCR readiness. *depends on 1; parallel with 4*

4. Phase 3 — Vision-provider safety and cost control
   4.1 Centralize capability gating in preflight checks for each step (`vision`, `verification`, `header-label`, `adjudicator`) and fail closed on incompatibility.
   4.2 Implement OpenRouter task-specific model filtering so vision-required tasks only use vision-capable models and enforce image-count/model-cap limits.
   4.3 Preserve settings-driven provider/model overrides, but guard all overrides with capability validation + fallback recommendations.
   4.4 Add policy tests proving no request budget is spent on text-only models for vision tasks. *depends on 1; parallel with 3*

5. Phase 4 — Metadata, naming, part extraction, chair packaging
   5.1 Validate/strengthen canonical naming and normalization pipeline (title/composer/arranger/instrument/chair/transposition).
   5.2 Ensure split/part manifests are deterministic and complete (no gaps/overlaps/invalid ranges).
   5.3 Implement chair-assignment policy from user decision:
       - each chair receives an assigned part;
       - if exact chair part missing, assign next available part of same instrument only;
       - preserve instrument-key/transposition correctness guardrails.
   5.4 Persist provenance for raw vs normalized metadata and assignment rationale for auditability. *depends on 2 and 3*

6. Phase 5 — Commit path, downstream library integrity, and review UX
   6.1 Verify idempotent commit contracts from session -> `MusicPiece`/`MusicFile`/`MusicPart` and crash-safe recovery.
   6.2 Ensure review/approve/reject/resplit routes enforce permission, status eligibility, and consistent post-state.
   6.3 Confirm uploaded assets and committed library records are visible/usable in music review and music library workflows. *depends on 4*

7. Phase 6 — Settings/UI/admin controls completeness
   7.1 Ensure all Smart Upload settings used at runtime are visible/editable/testable in admin UI and API.
   7.2 Add provider/model capability hints and warnings in settings UI (vision-required steps clearly indicated).
   7.3 Add confidence/risk visibility in review UI for low-confidence sessions and routing reasons. *depends on 3 and 5*

8. Phase 7 — Enterprise test and release gates
   8.1 Expand automated coverage by stage: intake, OCR-first, fallback routing, provider gating, split validation, commit idempotency, review operations, chair assignment rules.
   8.2 Add install verification tests/scripts for new machine bootstrap (`npm/pnpm install` + health checks).
   8.3 Run end-to-end datasets (combined PDF + multi-PDF) and establish release SLO gates.
   8.4 Ship final runbooks and rollback playbooks for operations. *depends on all prior phases*

9. Phase 8 — Documentation deliverables and handoff
   9.1 Create canonical docs artifact: `/home/dylan/eccb.app/docs/SMART_UPLOAD_ENTERPRISE_COMPLETION_PLAN.md`.
   9.2 Include architecture, dependencies, install matrix, provider gating matrix, chair assignment policy, test matrix, deployment gates.
   9.3 Link from README/docs index and deprecate conflicting docs references. *final step*

**Relevant files**
- `/home/dylan/eccb.app/src/app/api/files/smart-upload/route.ts` — intake validation, dedupe, session creation, queueing.
- `/home/dylan/eccb.app/src/workers/smart-upload-processor.ts` — first-pass orchestration, OCR-first and fallback routing.
- `/home/dylan/eccb.app/src/workers/smart-upload-worker.ts` — second-pass verification/adjudication and split handling.
- `/home/dylan/eccb.app/src/workers/smart-upload-processor-worker.ts` — unified job dispatch/ownership and concurrency.
- `/home/dylan/eccb.app/src/workers/ocr-worker.ts` — OCR subflow and rate limiting.
- `/home/dylan/eccb.app/src/lib/llm/config-loader.ts` — runtime config + per-step adapter config + capability validation hooks.
- `/home/dylan/eccb.app/src/lib/llm/capabilities.ts` — model capability policy (vision/pdf/json/image limits).
- `/home/dylan/eccb.app/src/lib/llm/providers.ts` — provider metadata, defaults, max image caps.
- `/home/dylan/eccb.app/src/lib/llm/index.ts` — shared LLM call path; assert capability preflight.
- `/home/dylan/eccb.app/src/lib/smart-upload/runtime-config.ts` — canonical settings facade/snapshot.
- `/home/dylan/eccb.app/src/lib/smart-upload/schema.ts` — settings keys/validation contract.
- `/home/dylan/eccb.app/src/lib/smart-upload/fallback-policy.ts` — route decision policy.
- `/home/dylan/eccb.app/src/lib/smart-upload/quality-gates.ts` — auto-commit safety gates.
- `/home/dylan/eccb.app/src/lib/smart-upload/part-naming.ts` — filename and part label normalization.
- `/home/dylan/eccb.app/src/lib/smart-upload/metadata-normalizer.ts` — metadata canonicalization.
- `/home/dylan/eccb.app/src/lib/services/ocr-fallback.ts` — OCR engine orchestration and external binary handling.
- `/home/dylan/eccb.app/src/lib/services/pdf-text-extractor.ts` — text/header extraction quality.
- `/home/dylan/eccb.app/src/lib/services/part-boundary-detector.ts` — deterministic boundary detection.
- `/home/dylan/eccb.app/src/lib/services/cutting-instructions.ts` — instruction validation/normalization.
- `/home/dylan/eccb.app/src/lib/services/pdf-splitter.ts` — part PDF generation and integrity.
- `/home/dylan/eccb.app/src/lib/smart-upload/commit.ts` — idempotent commit into music library entities.
- `/home/dylan/eccb.app/src/app/api/admin/uploads/review/[id]/approve/route.ts` — manual approval path.
- `/home/dylan/eccb.app/src/app/api/admin/uploads/review/[id]/reject/route.ts` — manual rejection path.
- `/home/dylan/eccb.app/src/app/api/admin/uploads/review/[id]/resplit/route.ts` — manual resplit/edit flow.
- `/home/dylan/eccb.app/src/app/api/admin/uploads/review/[id]/preview/route.ts` — preview reliability/error-classification.
- `/home/dylan/eccb.app/src/components/admin/music/smart-upload-settings-form.tsx` — settings completeness and provider UX.
- `/home/dylan/eccb.app/src/app/(admin)/admin/uploads/review/page.tsx` — operator review workflow.
- `/home/dylan/eccb.app/prisma/schema.prisma` — session/library persistence contracts and indexes.
- `/home/dylan/eccb.app/package.json` — install scripts and dependency lifecycle.
- `/home/dylan/eccb.app/env.example` — provider/OCR bootstrap env guidance.
- `/home/dylan/eccb.app/docker-compose.yml` and `/home/dylan/eccb.app/services/glm-ocr/**` — optional OCR service path.
- `/home/dylan/eccb.app/docs/smart-upload/*.md` and `/home/dylan/eccb.app/docs/SMART_UPLOAD_PRODUCTION_*.md` — doc reconciliation sources.

**Verification**
1. Dependency/install verification
   1.1 Run clean-machine install simulation (`pnpm install --frozen-lockfile` and optionally `npm install`) and verify OCR readiness script reports explicit pass/warn states.
   1.2 Verify optional system binaries (`ocrmypdf`, `ghostscript`, `poppler-utils`) are detected and warnings are surfaced, not silent failure.
2. Provider gating verification
   2.1 Unit tests for capability checks: vision task + text-only model must hard-fail before network call.
   2.2 OpenRouter model-list filter tests: vision-required steps expose only compatible models.
   2.3 Integration tests for image cap enforcement and second-pass clamping.
3. Pipeline correctness verification
   3.1 E2E: combined PDF packet -> parsed parts -> split outputs -> commit -> visible in library.
   3.2 E2E: multi-PDF packet -> merged session lineage -> per-part commit and metadata linking.
   3.3 E2E: low confidence/gap path routes to review; no unsafe auto-commit.
4. Chair assignment verification
   4.1 Policy tests: missing chair receives next available same-instrument part only.
   4.2 Transposition/key guard tests prevent cross-instrument/cross-key misassignment.
5. Idempotency and resilience verification
   5.1 Retry same session commit multiple times: no duplicate `MusicPiece`/`MusicFile`/`MusicPart` pollution.
   5.2 Worker crash/restart simulations preserve truthful session state and recover safely.
6. Operations verification
   6.1 Preview/events/review endpoints return stable, classified error responses.
   6.2 Metrics and error codes are emitted for all failure classes.

**Decisions**
- Include both combined single-PDF and multiple-PDF upload paths.
- Autonomy behavior must follow smart-upload admin threshold settings (not hardcoded policy).
- Chair policy: each chair must receive a part; missing chair uses next available part of same instrument only, with transposition/key correctness checks.
- OCR extras are optional but must surface health-check warnings on missing binaries/services.
- OpenRouter remains enabled, but vision-required tasks must show/use only vision-compatible models.

**Scope boundaries**
- Included: Smart Upload intake, OCR/LLM pipeline, review/commit, music-library persistence, provider gating, install/dependency reliability, docs/runbooks.
- Excluded: unrelated public CMS/stand features except where they consume committed music library records.

**Further Considerations**
1. Multi-PDF packet semantics recommendation: create one parent ingest session with child file manifests for deterministic retryability.
2. Provider policy recommendation: keep OpenRouter available for cost control, but default verification provider to stable vision-capable model with strict allowlist.
3. Deployment recommendation: run staged rollout with auto-commit initially constrained by higher thresholds, then relax after confidence telemetry stabilizes.