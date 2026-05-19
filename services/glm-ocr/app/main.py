import asyncio
import base64
import binascii
import io
import logging
import os
import time
from dataclasses import dataclass
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, status
from pydantic import BaseModel, Field
from PIL import Image, UnidentifiedImageError


LOGGER = logging.getLogger("glm_ocr_service")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper())


MODEL_ID = os.getenv("MODEL_ID", "zai-org/GLM-OCR")
MAX_CONCURRENT_REQUESTS = max(1, int(os.getenv("MAX_CONCURRENT_REQUESTS", "1")))
MAX_IMAGE_PIXELS = max(1, int(os.getenv("MAX_IMAGE_PIXELS", "20000000")))
MAX_NEW_TOKENS = max(1, int(os.getenv("MAX_NEW_TOKENS", "4096")))
GLM_OCR_AUTH_TOKEN = os.getenv("GLM_OCR_AUTH_TOKEN", "").strip()
REQUIRE_CUDA = os.getenv("REQUIRE_CUDA", "true").lower() != "false"


@dataclass
class ModelState:
    model: Any | None = None
    processor: Any | None = None
    ready: bool = False
    error: str | None = None
    cuda_available: bool = False
    model_id: str = MODEL_ID


STATE = ModelState()
SEMAPHORE = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)


class HealthResponse(BaseModel):
    status: str
    model_id: str
    cuda_available: bool
    ready: bool
    error: str | None = None


class ChatMessagePart(BaseModel):
    type: str
    text: str | None = None
    image_url: dict[str, str] | None = None


class ChatMessage(BaseModel):
    role: str
    content: str | list[ChatMessagePart]


class ChatCompletionRequest(BaseModel):
    model: str = Field(default=MODEL_ID)
    messages: list[ChatMessage]
    max_tokens: int | None = Field(default=None)
    temperature: float | None = Field(default=None)
    response_format: dict[str, Any] | None = None


def require_auth(authorization: str | None = Header(default=None)) -> None:
    if not GLM_OCR_AUTH_TOKEN:
        return

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")

    token = authorization.removeprefix("Bearer ").strip()
    if token != GLM_OCR_AUTH_TOKEN:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid bearer token")


def decode_data_url(data_url: str) -> Image.Image:
    if not data_url.startswith("data:") or ";base64," not in data_url:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid image data URL")

    _, encoded = data_url.split(";base64,", 1)
    try:
        image_bytes = base64.b64decode(encoded, validate=True)
    except binascii.Error as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid base64 image payload") from exc

    try:
        image = Image.open(io.BytesIO(image_bytes))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Unsupported image payload") from exc

    if image.width * image.height > MAX_IMAGE_PIXELS:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Image exceeds pixel limit of {MAX_IMAGE_PIXELS}",
        )

    if image.mode != "RGB":
        image = image.convert("RGB")

    return image


def extract_prompt_and_image(request: ChatCompletionRequest) -> tuple[list[dict[str, Any]], int]:
    image_count = 0
    normalized_messages: list[dict[str, Any]] = []

    for message in request.messages:
        if isinstance(message.content, str):
            normalized_messages.append(
                {
                    "role": message.role,
                    "content": [{"type": "text", "text": message.content}],
                }
            )
            continue

        normalized_parts: list[dict[str, Any]] = []
        for part in message.content:
            if part.type == "text" and part.text is not None:
                normalized_parts.append({"type": "text", "text": part.text})
                continue

            if part.type == "image_url" and part.image_url and part.image_url.get("url"):
                image_count += 1
                if image_count > 1:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="GLM-OCR accepts at most one image per request",
                    )
                normalized_parts.append(
                    {
                        "type": "image",
                        "image": decode_data_url(part.image_url["url"]),
                    }
                )
                continue

        normalized_messages.append({"role": message.role, "content": normalized_parts})

    if image_count == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="At least one image is required")

    return normalized_messages, image_count


def _load_model() -> None:
    try:
        import torch
        from transformers import AutoModelForImageTextToText, AutoProcessor

        STATE.cuda_available = torch.cuda.is_available()

        if REQUIRE_CUDA and not STATE.cuda_available:
            STATE.ready = False
            STATE.error = "CUDA unavailable"
            LOGGER.warning("GLM-OCR readiness blocked: CUDA unavailable")
            return

        model_kwargs: dict[str, Any] = {}
        if STATE.cuda_available:
            model_kwargs["device_map"] = "cuda:0"
            model_kwargs["torch_dtype"] = torch.bfloat16
        else:
            model_kwargs["torch_dtype"] = torch.float32

        processor = AutoProcessor.from_pretrained(MODEL_ID)
        model = AutoModelForImageTextToText.from_pretrained(MODEL_ID, **model_kwargs)

        if not STATE.cuda_available:
            model = model.to("cpu")

        STATE.processor = processor
        STATE.model = model
        STATE.ready = True
        STATE.error = None
        LOGGER.info("GLM-OCR model loaded", extra={"model_id": MODEL_ID, "cuda": STATE.cuda_available})
    except Exception as exc:
        STATE.ready = False
        STATE.error = f"Model load failed: {type(exc).__name__}"
        LOGGER.exception("Failed to load GLM-OCR model")


def ensure_ready() -> None:
    if not STATE.ready or STATE.model is None or STATE.processor is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=STATE.error or "Model not ready")


def generate_completion(normalized_messages: list[dict[str, Any]], max_tokens: int) -> tuple[str, dict[str, int]]:
    import torch

    ensure_ready()
    processor = STATE.processor
    model = STATE.model

    inputs = processor.apply_chat_template(
        normalized_messages,
        tokenize=True,
        add_generation_prompt=True,
        return_dict=True,
        return_tensors="pt",
    )
    inputs = inputs.to(model.device)

    input_len = int(inputs.input_ids.shape[-1])

    with torch.inference_mode():
        generated = model.generate(**inputs, max_new_tokens=max_tokens)

    generated_text = processor.decode(generated[0][input_len:], skip_special_tokens=True)
    usage = {
        "prompt_tokens": input_len,
        "completion_tokens": max(0, int(generated.shape[-1]) - input_len),
        "total_tokens": int(generated.shape[-1]),
    }
    return generated_text, usage


app = FastAPI(title="GLM-OCR Local Service", version="1.0.0")


@app.on_event("startup")
async def startup_event() -> None:
    await asyncio.to_thread(_load_model)


@app.get("/healthz", response_model=HealthResponse)
async def healthz() -> HealthResponse:
    return HealthResponse(
      status="ok",
      model_id=STATE.model_id,
      cuda_available=STATE.cuda_available,
      ready=STATE.ready,
      error=STATE.error,
    )


@app.get("/readyz", response_model=HealthResponse)
async def readyz() -> HealthResponse:
    if not STATE.ready:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=HealthResponse(
                status="not_ready",
                model_id=STATE.model_id,
                cuda_available=STATE.cuda_available,
                ready=False,
                error=STATE.error,
            ).model_dump(),
        )

    return HealthResponse(
        status="ready",
        model_id=STATE.model_id,
        cuda_available=STATE.cuda_available,
        ready=True,
    )


@app.post("/v1/chat/completions", dependencies=[Depends(require_auth)])
async def chat_completions(request: ChatCompletionRequest) -> dict[str, Any]:
    ensure_ready()
    normalized_messages, image_count = extract_prompt_and_image(request)
    max_tokens = min(request.max_tokens or MAX_NEW_TOKENS, MAX_NEW_TOKENS)
    started_at = time.time()

    async with SEMAPHORE:
        try:
            content, usage = await asyncio.to_thread(generate_completion, normalized_messages, max_tokens)
        except HTTPException:
            raise
        except Exception as exc:
            LOGGER.exception("GLM-OCR inference failure")
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Inference failed: {type(exc).__name__}",
            ) from exc

    return {
        "id": f"chatcmpl-{int(started_at * 1000)}",
        "object": "chat.completion",
        "created": int(started_at),
        "model": request.model or MODEL_ID,
        "choices": [
            {
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": content,
                },
                "finish_reason": "stop",
            }
        ],
        "usage": usage,
        "service_tier": "local",
        "metadata": {
            "image_count": image_count,
            "cuda": STATE.cuda_available,
        },
    }


@app.get("/v1/models", dependencies=[Depends(require_auth)])
async def list_models() -> dict[str, Any]:
    return {
        "object": "list",
        "data": [
            {
                "id": MODEL_ID,
                "object": "model",
                "owned_by": "zai-org",
            }
        ],
    }
