# GLM-OCR Local Service

This service hosts `zai-org/GLM-OCR` behind an internal OpenAI-compatible endpoint for ECCB Smart Upload.

## Purpose

- Keep Smart Upload on the existing OCR-first queue architecture
- Run OCR on a local NVIDIA GPU service instead of inside the Next.js worker
- Accept rendered page images and header crops, not full PDFs, as the primary path
- Support rollback by provider/settings changes rather than code reverts

## Endpoints

- `GET /healthz`
- `GET /readyz`
- `POST /v1/chat/completions`

## Required environment

- `MODEL_ID=zai-org/GLM-OCR`
- `MAX_CONCURRENT_REQUESTS=1`
- `MAX_IMAGE_PIXELS=20000000`
- `MAX_NEW_TOKENS=4096`
- `GLM_OCR_AUTH_TOKEN=` optional bearer token for internal calls
- `REQUIRE_CUDA=true`
- `HF_HOME=/models/huggingface`
- `TRANSFORMERS_CACHE=/models/huggingface`

## Behavior and safety

- Binds to the container port `8090`
- Intended for localhost or internal Docker-network exposure only
- Rejects malformed image data URLs
- Rejects images above the configured pixel budget
- Limits concurrent inference with a semaphore
- Does not log base64 payloads or OCR output text
- Reports CUDA availability through `/readyz`

## Local compose usage

From the repo root:

```bash
docker compose up -d glm-ocr
```

The app should target:

```text
http://glm-ocr:8090/v1
```

For host-local access during development:

```text
http://127.0.0.1:8090/v1
```

## Request shape

The service accepts an OpenAI-style `chat.completions` payload with:

- one image via `messages[].content[].image_url.url` using a data URL
- text instructions via `messages[].content[].text`

It intentionally enforces a single-image request path for now because Smart Upload already batches work at the pipeline level and this keeps GPU memory predictable.
