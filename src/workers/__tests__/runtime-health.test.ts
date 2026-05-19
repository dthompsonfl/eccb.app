import { describe, expect, it } from 'vitest';

import { evaluateWorkerRuntimeHealth } from '../runtime-health';

describe('evaluateWorkerRuntimeHealth', () => {
  it('marks the worker runtime unhealthy when OCR is down', () => {
    const result = evaluateWorkerRuntimeHealth({
      email: true,
      scheduler: true,
      smartUpload: true,
      ocr: false,
      sockets: false,
      socketsRequired: false,
    });

    expect(result.healthy).toBe(false);
    expect(result.ready).toBe(false);
  });

  it('does not require sockets when embedded websocket mode is disabled', () => {
    const result = evaluateWorkerRuntimeHealth({
      email: true,
      scheduler: true,
      smartUpload: true,
      ocr: true,
      sockets: false,
      socketsRequired: false,
    });

    expect(result.healthy).toBe(true);
    expect(result.ready).toBe(true);
  });

  it('requires sockets when embedded websocket mode is enabled', () => {
    const result = evaluateWorkerRuntimeHealth({
      email: true,
      scheduler: true,
      smartUpload: true,
      ocr: true,
      sockets: false,
      socketsRequired: true,
    });

    expect(result.healthy).toBe(false);
    expect(result.ready).toBe(false);
  });
});
