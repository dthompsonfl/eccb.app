# Smart Upload GLM-OCR Migration

This document describes the local `zai-org/GLM-OCR` integration for ECCB Smart Upload.

## What changed

Smart Upload keeps its existing architecture:

- upload validation
- auth, CSRF, and rate limiting
- duplicate detection
- original PDF storage
- Smart Upload queue processing
- deterministic splitting
- OCR-first routing
- quality gates
- second-pass or review fallback
- rollback by settings

The migration replaces the vision/OCR model provider path with a first-class local `glm-ocr` provider backed by a separate FastAPI GPU service.

## Model and service

- Hugging Face model: `zai-org/GLM-OCR`
- Runtime pattern: separate local service under `services/glm-ocr`
- Transport: OpenAI-compatible `POST /v1/chat/completions`
- Input mode: rendered page images and header crops as data URLs
- Default endpoint: `http://glm-ocr:8090/v1`

Native PDF mode stays disabled for `glm-ocr`.

## NVIDIA GPU requirement

This service is intended for NVIDIA GPU inference.

- `REQUIRE_CUDA=true` keeps `/readyz` unhealthy when CUDA is unavailable
- `MAX_CONCURRENT_REQUESTS=1` is the conservative default
- model weights are cached in a persistent Hugging Face volume

## Recommended Smart Upload settings

Use these settings through the admin Smart Upload settings UI:

- `llm_default_provider=glm-ocr`
- `llm_endpoint_url=http://glm-ocr:8090/v1`
- `llm_vision_provider=glm-ocr`
- `llm_vision_model=zai-org/GLM-OCR`
- `llm_header_label_provider=glm-ocr`
- `llm_header_label_model=zai-org/GLM-OCR`
- `llm_verification_provider=glm-ocr`
- `llm_verification_model=zai-org/GLM-OCR`
- `llm_adjudicator_provider=glm-ocr`
- `llm_adjudicator_model=zai-org/GLM-OCR`
- `smart_upload_enable_ocr_first=true`
- `smart_upload_enforce_ocr_splitting=true`
- `smart_upload_send_full_pdf_to_llm=false`
- `smart_upload_store_raw_ocr_text=false`

## Security defaults

- keep the service bound to localhost or an internal Docker network
- set `GLM_OCR_AUTH_TOKEN` when the app and service are not sharing a fully private network
- do not commit secrets
- the service does not log base64 image payloads or OCR text

## Startup

```bash
docker compose up -d glm-ocr
```

Readiness checks:

- `GET /healthz`
- `GET /readyz`

## Validation commands

Use the repo-native command set:

```bash
pnpm install --no-frozen-lockfile
pnpm run lint
pnpm exec tsc --noEmit
pnpm run test:run
pnpm run test:smart-upload:fixtures
pnpm run build
```

Run E2E only when the environment has the required database, Redis, and Playwright browsers configured.

## Rollback

Rollback is configuration-driven:

1. change Smart Upload provider selections away from `glm-ocr`
2. restore the previous endpoint and model values in admin settings
3. stop the `glm-ocr` service

No code revert should be required for a normal provider rollback.
