import 'dotenv/config';

import { Worker, type Job, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';

import { prisma } from '@/lib/db';
import { logger } from '@/lib/logger';
import { QUEUE_NAMES } from '@/lib/jobs/definitions';
import { loadSmartUploadRuntimeConfig } from '@/lib/llm/config-loader';
import { downloadFile } from '@/lib/services/storage';
import { extractOcrFallbackMetadata, type OcrFallbackOptions } from '@/lib/services/ocr-fallback';
import { parseSmartUploadJsonField, serializeSmartUploadJsonField } from '@/lib/smart-upload/persistence';

/**
 * OCR Worker
 *
 * Dedicated rate-limited worker for non-LLM OCR fallback processing.
 *
 * Why a dedicated queue:
 * - BullMQ workers consume *all* jobs in a queue. If OCR ran on the Smart Upload queue,
 *   it could accidentally pick up smartupload.process jobs and "complete" them incorrectly.
 *
 * Rate limiting:
 * - Uses BullMQ limiter (distributed / process-safe).
 * - Also supports concurrency control.
 *
 * Security:
 * - Never logs PDF bytes.
 * - Never logs extracted OCR text.
 * - Only logs metrics (durations, sizes, confidence).
 */

// =============================================================================
// Queue & Worker Configuration
// =============================================================================

/**
 * Dedicated OCR queue name.
 * Keep this stable; you will enqueue OCR jobs to this queue.
 */
const OCR_QUEUE_NAME = QUEUE_NAMES.OCR;

/**
 * Concurrency setting - infra-only, not related to Smart Upload behavior.
 * This is kept as env-only since it's a worker infra concern.
 */
const OCR_WORKER_CONCURRENCY = parseInt(process.env.OCR_WORKER_CONCURRENCY || '1', 10);

/**
 * Lock duration should exceed worst-case OCR time to prevent job "stalls".
 * If your OCR sometimes takes > 10 minutes, increase this.
 */
const OCR_WORKER_LOCK_DURATION_MS = parseInt(
  process.env.OCR_WORKER_LOCK_DURATION_MS || String(15 * 60 * 1000),
  10
);

/**
 * Cached config for OCR worker.
 * Loaded once at startup via loadOcrConfig().
 */
let cachedOcrConfig: Awaited<ReturnType<typeof loadSmartUploadRuntimeConfig>> | null = null;

/**
 * Load OCR config from DB (Smart Upload settings).
 * Uses cached value if available to avoid repeated DB calls.
 */
async function loadOcrConfig() {
  if (!cachedOcrConfig) {
    cachedOcrConfig = await loadSmartUploadRuntimeConfig();
  }
  return cachedOcrConfig;
}

/**
 * Build default OCR options from DB config.
 * This is the DB-driven behavior - no runtime env fallbacks for OCR behavior.
 */
async function getDefaultOcrOptions(): Promise<OcrFallbackOptions> {
  const cfg = await loadOcrConfig();

  return {
    maxTextProbePages: cfg.textProbePages,
    // Only tesseract is a local Tesseract OCR engine; ocrmypdf is a separate pipeline
    enableTesseractOcr: cfg.ocrEngine === 'tesseract',
    ocrEngine: cfg.ocrEngine,
    ocrMode: cfg.ocrMode,
    maxOcrPages: cfg.ocrMaxPages ?? 0,
    renderScale: 2, // Keep render defaults - not exposed as settings
    renderMaxWidth: 1024,
    renderFormat: 'png',
    renderQuality: 85,
    autoAcceptConfidenceThreshold: cfg.ocrConfidenceThreshold,
  };
}

// =============================================================================
// Types
// =============================================================================

export type OcrJobName = 'ocr.process';

export interface OcrProcessJobData {
  /**
   * SmartUploadSession.uploadSessionId
   * We use uploadSessionId as your system-wide identifier.
   */
  sessionId: string;

  /**
   * Optional override – if provided we’ll use this storageKey instead of reading from the session.
   * Useful if you want to OCR a derived PDF.
   */
  storageKey?: string;

  /**
   * Optional override filename (defaults to session.fileName)
   */
  filename?: string;

  /**
   * Optional per-job OCR option overrides (merged over defaults)
   */
  options?: Partial<OcrFallbackOptions>;

  /**
   * If true, OCR results will overwrite existing extractedMetadata.title/composer,
   * otherwise we only fill missing fields.
   * Default: false
   */
  overwriteExistingMetadata?: boolean;

  /**
   * If true, mark parseStatus even if other pipeline steps exist.
   * Default: true
   */
  updateParseStatus?: boolean;
}

// =============================================================================
// Internal state
// =============================================================================

let worker: Worker<OcrProcessJobData> | null = null;
let redis: Redis | null = null;
let workerStarting = false;

// =============================================================================
// Utilities
// =============================================================================

function nowMs(): number {
   
  const perf = (globalThis as any)?.performance;
  if (perf?.now) return perf.now();
  return Date.now();
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

function safeErrorDetails(err: unknown) {
  const e = asError(err);
  return { errorMessage: e.message, errorName: e.name, errorStack: e.stack };
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * Download storageKey into a Buffer.
 * - LOCAL driver: downloadFile returns {stream, metadata}
 * - S3 driver in your current storage.ts: downloadFile returns a signed URL string
 */
async function downloadPdfAsBuffer(storageKey: string): Promise<{ buffer: Buffer; sizeBytes?: number }> {
  const result = await downloadFile(storageKey);

  // Local: stream + metadata
  if (typeof result !== 'string') {
    const buffer = await streamToBuffer(result.stream);
    return { buffer, sizeBytes: result.metadata.size };
  }

  // S3: signed URL string
  const signedUrl = result;
  // Node 18+ has global fetch. We do not log the URL.
  const resp = await fetch(signedUrl);
  if (!resp.ok) {
    throw new Error(`Failed to download file from signed URL (status ${resp.status})`);
  }

  const arr = await resp.arrayBuffer();
  return { buffer: Buffer.from(arr), sizeBytes: Buffer.byteLength(Buffer.from(arr)) };
}

/**
 * Merge OCR metadata into existing SmartUploadSession.extractedMetadata.
 * We keep this conservative to avoid breaking downstream consumers.
 */
function mergeExtractedMetadata(
  existing: unknown,
  ocr: { title: string; composer?: string; confidence: number; isImageScanned: boolean; needsManualReview: boolean },
  overwrite: boolean
): Record<string, unknown> {
  const base = parseSmartUploadJsonField<Record<string, unknown>>(existing, {});

  const existingTitle = typeof base.title === 'string' ? base.title : undefined;
  const existingComposer = typeof base.composer === 'string' ? base.composer : undefined;

  const next: Record<string, unknown> = { ...base };

  if (overwrite || !existingTitle) next.title = ocr.title;
  if (overwrite || (!existingComposer && ocr.composer)) next.composer = ocr.composer;

  // Add non-breaking provenance fields (safe for downstream)
  next.ocrFallback = {
    confidence: ocr.confidence,
    isImageScanned: ocr.isImageScanned,
    needsManualReview: ocr.needsManualReview,
    processedAt: new Date().toISOString(),
  };

  return next;
}

// =============================================================================
// Processor
// =============================================================================

async function processOcrJob(job: Job<OcrProcessJobData>): Promise<void> {
  const start = nowMs();

  if (job.name !== 'ocr.process') {
    // This worker is intended for a dedicated OCR queue. If misconfigured,
    // fail loudly so it doesn’t silently “complete” unknown work.
    throw new Error(`OCR worker received unexpected job name: ${job.name}`);
  }

  const { sessionId, storageKey: overrideKey, filename: overrideFilename } = job.data;

  logger.info('OCR job started', {
    jobId: job.id,
    name: job.name,
    sessionId,
  });

  // 1) Load session (source of truth)
  const session = await prisma.smartUploadSession.findUnique({
    where: { uploadSessionId: sessionId },
  });

  if (!session) {
    throw new Error(`SmartUploadSession not found (uploadSessionId=${sessionId})`);
  }

  const storageKey = overrideKey || session.storageKey;
  const filename = overrideFilename || session.fileName;

  // 2) Download PDF into buffer (no logging of content)
  const dlStart = nowMs();
  const { buffer: pdfBuffer, sizeBytes } = await downloadPdfAsBuffer(storageKey);
  const downloadDurationMs = Math.round(nowMs() - dlStart);

  // 3) Run deterministic OCR fallback extraction
  const defaultOptions = await getDefaultOcrOptions();
  const mergedOptions: OcrFallbackOptions = {
    ...defaultOptions,
    ...(job.data.options || {}),
    // enforce enableTesseractOcr by DB config if you want a hard kill-switch:
    enableTesseractOcr: (job.data.options?.enableTesseractOcr ?? defaultOptions.enableTesseractOcr),
  };

  const ocrStart = nowMs();
  const ocrMeta = await extractOcrFallbackMetadata({
    pdfBuffer,
    filename,
    options: mergedOptions,
  });
  const ocrDurationMs = Math.round(nowMs() - ocrStart);

  // 4) Update session
  const overwriteExisting = !!job.data.overwriteExistingMetadata;
  const updateParseStatus = job.data.updateParseStatus !== false;

  const updatedExtracted = mergeExtractedMetadata(session.extractedMetadata, ocrMeta, overwriteExisting);

  await prisma.smartUploadSession.update({
    where: { uploadSessionId: sessionId },
    data: {
      extractedMetadata: serializeSmartUploadJsonField(updatedExtracted),
      confidenceScore: Math.round(ocrMeta.confidence),
      // Mark provenance: not an LLM run
      llmProvider: session.llmProvider || 'ocr-fallback',
      llmPromptVersion: session.llmPromptVersion || 'ocr-fallback-v1',
      // These are optional but helpful for UI/ops:
      parseStatus: updateParseStatus ? 'OCR_FALLBACK_COMPLETE' : session.parseStatus,
      secondPassStatus: session.secondPassStatus || 'SKIPPED_OCR_FALLBACK',
      secondPassResult: session.secondPassResult || JSON.stringify({ ocrFallback: true }),
      updatedAt: new Date(),
    },
  });

  logger.info('OCR job completed', {
    jobId: job.id,
    name: job.name,
    sessionId,
    storageKey,
    sizeBytes,
    downloadDurationMs,
    ocrDurationMs,
    confidence: ocrMeta.confidence,
    isImageScanned: ocrMeta.isImageScanned,
    needsManualReview: ocrMeta.needsManualReview,
    totalDurationMs: Math.round(nowMs() - start),
  });
}

// =============================================================================
// Public lifecycle
// =============================================================================

/**
 * Start OCR worker (rate-limited).
 */
export function startOcrWorker(): void {
  if (worker || workerStarting) return;
  workerStarting = true;

  // Dedicated Redis connection for this worker.
  // We avoid importing internal helpers to keep this module isolated and production-ready.
  const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
  const redisConnection = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  const bullConnection = redisConnection as unknown as ConnectionOptions;
  redis = redisConnection;

  // Load config at startup to get DB-driven rate limit
  // This uses smart_upload_ocr_rate_limit_rpm from DB settings
  loadOcrConfig().then((cfg) => {
    const limiterRpm = cfg.ocrRateLimitRpm;

    worker = new Worker<OcrProcessJobData>(OCR_QUEUE_NAME, processOcrJob, {
      connection: bullConnection,
      concurrency: Math.max(1, OCR_WORKER_CONCURRENCY),
      lockDuration: OCR_WORKER_LOCK_DURATION_MS,
      // Distributed-safe rate limiting - DB-driven
      limiter: {
        max: Math.max(1, limiterRpm),
        duration: 60_000,
      },
    });

    worker.on('completed', (job) => {
      logger.debug('OCR worker: job completed', { jobId: job.id, name: job.name });
    });

    worker.on('failed', (job, err) => {
      const details = safeErrorDetails(err);
      logger.error('OCR worker: job failed', {
        jobId: job?.id,
        name: job?.name,
        attemptsMade: job?.attemptsMade,
        ...details,
      });
    });

    worker.on('error', (err) => {
      const details = safeErrorDetails(err);
      logger.error('OCR worker: worker error', details);
    });

    logger.info('OCR worker started', {
      queue: OCR_QUEUE_NAME,
      concurrency: OCR_WORKER_CONCURRENCY,
      limiterRpm,
      ocrEngine: cfg.ocrEngine,
      ocrMode: cfg.ocrMode,
    });
    workerStarting = false;
  }).catch((err) => {
    logger.error('OCR worker: failed to load config, using fallback rate limit', { err });
    // Fallback to conservative rate limit if config load fails
    worker = new Worker<OcrProcessJobData>(OCR_QUEUE_NAME, processOcrJob, {
      connection: bullConnection,
      concurrency: Math.max(1, OCR_WORKER_CONCURRENCY),
      lockDuration: OCR_WORKER_LOCK_DURATION_MS,
      limiter: {
        max: 6, // Conservative fallback
        duration: 60_000,
      },
    });
    workerStarting = false;
  }).finally(() => {
    workerStarting = false;
  });
}

/**
 * Stop OCR worker gracefully.
 */
export async function stopOcrWorker(): Promise<void> {
  const w = worker;
  const r = redis;

  worker = null;
  redis = null;
  workerStarting = false;

  try {
    if (w) {
      await w.close();
      logger.info('OCR worker stopped');
    }
  } catch (err) {
    logger.warn('OCR worker stop failed', safeErrorDetails(err));
  }

  try {
    if (r) {
      await r.quit();
    }
  } catch {
    // ignore
  }
}

export function isOcrWorkerRunning(): boolean {
  return !!worker;
}
