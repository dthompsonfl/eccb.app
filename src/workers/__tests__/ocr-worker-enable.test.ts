/**
 * Tests for the `ENABLE_OCR_WORKER` gate.
 *
 * The dedicated OCR queue has exactly one producer
 * (`POST /api/admin/uploads/review/[id]/reocr`), so an operator who never uses
 * that endpoint is holding a BullMQ consumer and a Redis connection open for
 * nothing. The switch releases both.
 *
 * The defect this guards against: `startOcrWorker()` becomes a no-op when
 * disabled, so `isOcrWorkerRunning()` correctly reports false. Folding that raw
 * false into the readiness computation made a deliberately-disabled worker
 * indistinguishable from a crashed one — the worker process answered /ready
 * with 503 forever and `npm run start:all` never reached a ready verdict, even
 * though everything the operator asked for was running.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const WorkerMock = vi.fn();
const redisQuitMock = vi.fn().mockResolvedValue(undefined);

// ocr-worker.ts uses `import Redis from 'ioredis'` and constructs it with `new`,
// so the mock must be a constructible class (a vi.fn() arrow implementation is
// not) and must be exposed as both the default and named export.
vi.mock('ioredis', () => {
  class FakeRedis {
    quit = redisQuitMock;
    on = vi.fn();
    disconnect = vi.fn();
  }
  return { Redis: FakeRedis, default: FakeRedis };
});

vi.mock('bullmq', () => {
  // Constructible: ocr-worker.ts does `new Worker(...)`. An arrow-function
  // implementation is not a constructor and throws inside the async
  // loadOcrConfig().then(...) — which has no .catch(), so the failure is
  // swallowed and the worker silently never starts.
  class FakeWorker {
    on = vi.fn();
    close = vi.fn();
    constructor(...args: unknown[]) {
      WorkerMock(...args);
    }
  }
  return { Worker: FakeWorker };
});

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({
  prisma: { systemSetting: { findFirst: vi.fn().mockResolvedValue(null) } },
}));

vi.mock('@/lib/jobs/definitions', () => ({
  QUEUE_NAMES: { OCR: 'eccb-ocr' },
}));

vi.mock('@/lib/smart-upload/runtime-config', () => ({
  loadSmartUploadRuntimeConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/services/storage', () => ({
  downloadFile: vi.fn(),
}));

vi.mock('@/lib/smart-upload/persistence', () => ({
  parseSmartUploadJsonField: vi.fn(),
  serializeSmartUploadJsonField: vi.fn(),
}));

vi.mock('@/lib/services/ocr-fallback', () => ({
  processOcrJob: vi.fn(),
  extractOcrFallbackMetadata: vi.fn(),
}));

const ORIGINAL_ENV = process.env.ENABLE_OCR_WORKER;

async function loadModule() {
  vi.resetModules();
  return import('../ocr-worker');
}

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.ENABLE_OCR_WORKER;
  else process.env.ENABLE_OCR_WORKER = ORIGINAL_ENV;
  vi.clearAllMocks();
});

describe('isOcrWorkerEnabled', () => {
  it('defaults to enabled when the variable is unset', async () => {
    delete process.env.ENABLE_OCR_WORKER;
    const { isOcrWorkerEnabled } = await loadModule();
    // Absent must mean ON: an operator who has never heard of this flag gets
    // the worker, so no existing deployment changes behaviour.
    expect(isOcrWorkerEnabled()).toBe(true);
  });

  it('treats false, 0 and no as disabled', async () => {
    const { isOcrWorkerEnabled } = await loadModule();
    for (const value of ['false', 'FALSE', '0', 'no', 'No']) {
      process.env.ENABLE_OCR_WORKER = value;
      expect(isOcrWorkerEnabled()).toBe(false);
    }
  });

  it('tolerates surrounding whitespace and treats other truthy values as enabled', async () => {
    const { isOcrWorkerEnabled } = await loadModule();
    process.env.ENABLE_OCR_WORKER = '  true  ';
    expect(isOcrWorkerEnabled()).toBe(true);
    process.env.ENABLE_OCR_WORKER = '1';
    expect(isOcrWorkerEnabled()).toBe(true);
  });
});

describe('startOcrWorker with ENABLE_OCR_WORKER=false', () => {
  beforeEach(() => {
    process.env.ENABLE_OCR_WORKER = 'false';
  });

  it('does not construct a BullMQ worker', async () => {
    const { startOcrWorker } = await loadModule();
    startOcrWorker();
    // The whole point: no consumer, no Redis connection held open for a queue
    // that only an operator-triggered endpoint ever writes to.
    expect(WorkerMock).not.toHaveBeenCalled();
  });

  it('leaves isOcrWorkerRunning() false, which is why readiness must not use it raw', async () => {
    const { startOcrWorker, isOcrWorkerRunning, isOcrWorkerEnabled } = await loadModule();
    startOcrWorker();
    expect(isOcrWorkerRunning()).toBe(false);
    // This pair is the contract callers must honour: not running AND not enabled.
    expect(isOcrWorkerEnabled()).toBe(false);
  });

  it('is safe to call repeatedly', async () => {
    const { startOcrWorker } = await loadModule();
    startOcrWorker();
    startOcrWorker();
    expect(WorkerMock).not.toHaveBeenCalled();
  });
});

describe('startOcrWorker with ENABLE_OCR_WORKER unset', () => {
  beforeEach(() => {
    delete process.env.ENABLE_OCR_WORKER;
  });

  it('still starts the worker', async () => {
    const { startOcrWorker } = await loadModule();
    startOcrWorker();
    // Construction is async (config is loaded from the DB first), so await a
    // microtask turn before asserting.
    await vi.waitFor(() => expect(WorkerMock).toHaveBeenCalled());
  });
});