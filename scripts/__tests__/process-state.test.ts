/**
 * Tests for the process manager's readiness model.
 *
 * The behaviour under test is the invariant that a live `ChildProcess` object
 * is NOT readiness — the defect that let a child which spawned and immediately
 * crashed be reported as healthy.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  deriveComponentState,
  deriveReadiness,
  evaluateNextServerProbe,
  evaluateWorkerProbe,
  ManagedState,
  ProbeResult,
  probeHttp,
} from '../process-state';

function state(overrides: Partial<ManagedState> & { name: string }): ManagedState {
  return {
    spawned: true,
    pid: 1234,
    lastProbe: null,
    failureCount: 0,
    restartCount: 0,
    lastExit: null,
    startedAt: Date.now(),
    ...overrides,
  };
}

function probe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return { ok: true, statusCode: 200, latencyMs: 1, ...overrides };
}

describe('deriveComponentState', () => {
  it('reports down when nothing was spawned', () => {
    expect(deriveComponentState(state({ name: 'next-server', spawned: false, pid: null }))).toBe('down');
  });

  it('reports starting for a spawned process that has not been probed yet', () => {
    // A live ChildProcess with no probe result is the exact state the old
    // implementation reported as healthy.
    expect(deriveComponentState(state({ name: 'workers' }))).toBe('starting');
  });

  it('reports ready only after a successful probe', () => {
    expect(deriveComponentState(state({ name: 'workers', lastProbe: probe() }))).toBe('ready');
  });

  it('distinguishes degraded (answered, unhealthy) from down (no answer)', () => {
    expect(
      deriveComponentState(state({ name: 'workers', lastProbe: probe({ ok: false, statusCode: 503 }) })),
    ).toBe('degraded');
    expect(
      deriveComponentState(state({ name: 'workers', lastProbe: probe({ ok: false, statusCode: undefined, error: 'ECONNREFUSED' }) })),
    ).toBe('down');
  });
});

describe('deriveReadiness', () => {
  it('is not ready when a spawned child has never been probed', () => {
    const result = deriveReadiness([state({ name: 'next-server' }), state({ name: 'workers' })]);
    expect(result.verdict).toBe('starting');
  });

  it('is not ready when a child crashed (handle exists, probe failed)', () => {
    const result = deriveReadiness([
      state({ name: 'next-server', lastProbe: probe() }),
      state({ name: 'workers', lastProbe: probe({ ok: false, error: 'ECONNREFUSED' }) }),
    ]);
    expect(result.verdict).toBe('not-ready');
  });

  it('is ready when every probed child answers', () => {
    const result = deriveReadiness([
      state({ name: 'next-server', lastProbe: probe() }),
      state({ name: 'workers', lastProbe: probe({ body: { ready: true } }) }),
    ]);
    expect(result.verdict).toBe('ready');
  });

  it('is not ready when the worker is up but real-time sync is expected and the socket server is absent', () => {
    // The silent-degradation case: everything answers 200, `sockets: false`.
    const result = deriveReadiness(
      [
        state({ name: 'next-server', lastProbe: probe({ body: { status: 'healthy' } }) }),
        state({ name: 'workers', lastProbe: probe({ body: { ready: true, sockets: false } }) }),
      ],
      { requireSockets: true },
    );
    expect(result.verdict).toBe('not-ready');
    expect(result.details.sockets).toMatchObject({ state: 'down' });
  });

  it('is ready with sockets running when real-time sync is expected', () => {
    const result = deriveReadiness(
      [
        state({ name: 'next-server', lastProbe: probe() }),
        state({ name: 'workers', lastProbe: probe({ body: { ready: true, sockets: true } }) }),
      ],
      { requireSockets: true },
    );
    expect(result.verdict).toBe('ready');
  });

  it('ignores socket absence when real-time sync is not expected', () => {
    const result = deriveReadiness(
      [
        state({ name: 'next-server', lastProbe: probe() }),
        state({ name: 'workers', lastProbe: probe({ body: { ready: true, sockets: false } }) }),
      ],
      { requireSockets: false },
    );
    expect(result.verdict).toBe('ready');
  });

  it('is not ready when no components are registered', () => {
    expect(deriveReadiness([]).verdict).toBe('not-ready');
  });

  it('exposes the pid and last exit so an operator can see a restart loop', () => {
    const result = deriveReadiness([
      state({
        name: 'workers',
        lastProbe: probe(),
        restartCount: 3,
        lastExit: { code: 1, signal: null, at: Date.now() },
      }),
    ]);
    expect(result.details.workers).toMatchObject({ restartCount: 3, lastExit: { code: 1 } });
  });
});

describe('evaluateNextServerProbe', () => {
  it('rejects an unhealthy payload even on HTTP 200', () => {
    expect(evaluateNextServerProbe(probe({ body: { status: 'healthy' } }))).toBe(true);
    expect(evaluateNextServerProbe(probe({ body: { status: 'unhealthy' } }))).toBe(false);
    expect(evaluateNextServerProbe(probe({ body: { status: 'degraded' } }))).toBe(true);
  });

  it('rejects any 5xx', () => {
    expect(evaluateNextServerProbe(probe({ ok: false, statusCode: 503 }))).toBe(false);
  });

  it('accepts a response with no JSON body', () => {
    expect(evaluateNextServerProbe(probe({ body: undefined }))).toBe(true);
  });
});

describe('evaluateWorkerProbe', () => {
  it('requires ready:true in the payload', () => {
    expect(evaluateWorkerProbe(probe({ body: { ready: true } }))).toBe(true);
    expect(evaluateWorkerProbe(probe({ body: { ready: false } }))).toBe(false);
  });
});

describe('probeHttp', () => {
  // Every listener opened here is closed in afterEach so no test leaves a
  // bound socket behind.
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('classifies a JSON 200 response', async () => {
    const http = await import('http');
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;

    const result = await probeHttp(port, '/ready');
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ ready: true });
  });

  it('classifies a 503 with no listener error', async () => {
    const http = await import('http');
    const server = http.createServer((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
    const port = (server.address() as { port: number }).port;

    const result = await probeHttp(port, '/health');
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(503);
  });

  it('reports a connection error rather than hanging when nothing is listening', async () => {
    // Port 1 on loopback is privileged and unbound: connect fails immediately.
    const result = await probeHttp(1, '/health', { timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.statusCode).toBeUndefined();
  });
});