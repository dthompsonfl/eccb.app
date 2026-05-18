import { describe, it, expect, vi, beforeEach } from 'vitest';


// Mock NextResponse
vi.mock('next/server', () => {
  return {
    NextResponse: {
      json: (body: any, init?: any) => ({
        body,
        status: init?.status || 200,
        // Add other properties if needed by the test
      }),
    },
  };
});

// Mock env with a factory function to avoid hoisting issues
// We'll use a getter to control the state
let mockSetupMode = false;
let mockSetupToken: string | undefined = undefined;

vi.mock('@/lib/env', () => ({
  env: {
    get SETUP_MODE() { return mockSetupMode; },
    get SETUP_TOKEN() { return mockSetupToken; },
  },
}));

import { validateSetupRequest } from '../setup/setup-guard';

describe('validateSetupRequest', () => {
  beforeEach(() => {
    // Ensure we test the fallback behavior by clearing process env overrides.
    delete process.env.SETUP_MODE;
    delete process.env.SETUP_TOKEN;

    mockSetupMode = false;
    mockSetupToken = undefined;
  });

  it('should return 403 if SETUP_MODE is false', async () => {
    mockSetupMode = false;
    const req = new Request('http://localhost');
    const res = await validateSetupRequest(req) as any;

    expect(res).not.toBeNull();
    expect(res?.status).toBe(403);
    expect(res?.body?.error).toBe('Setup mode is disabled');
  });

  it('should return 401 if SETUP_MODE is true but token is missing and SETUP_TOKEN is configured', async () => {
    mockSetupMode = true;
    mockSetupToken = 'secret';

    const req = new Request('http://localhost');
    const res = await validateSetupRequest(req) as any;

    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
    expect(res?.body?.error).toBe('Invalid setup token');
  });

  it('should return 401 if token is incorrect', async () => {
    mockSetupMode = true;
    mockSetupToken = 'secret';

    const req = new Request('http://localhost', {
      headers: { 'x-setup-token': 'wrong' },
    });
    const res = await validateSetupRequest(req) as any;

    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
  });

  it('should return null (success) if token is correct', async () => {
    mockSetupMode = true;
    mockSetupToken = 'secret';

    const req = new Request('http://localhost', {
      headers: { 'x-setup-token': 'secret' },
    });
    const res = await validateSetupRequest(req);

    expect(res).toBeNull();
  });

  it('should return null (success) if SETUP_MODE is true and no token configured', async () => {
    mockSetupMode = true;
    mockSetupToken = undefined;

    const req = new Request('http://localhost');
    const res = await validateSetupRequest(req);

    expect(res).toBeNull();
  });

  it('should respect process.env overrides for setup mode', async () => {
    // Force setup mode off at runtime, even if env module says true
    mockSetupMode = true;
    process.env.SETUP_MODE = 'false';

    const req = new Request('http://localhost');
    const res = await validateSetupRequest(req) as any;

    expect(res).not.toBeNull();
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Setup mode is disabled');
  });
});
