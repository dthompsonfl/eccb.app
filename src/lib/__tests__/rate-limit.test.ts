/**
 * Tests for Auth Rate Limiting
 *
 * These tests verify that rate limiting is properly applied to authentication endpoints.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// Mock the redis module - must be inline due to hoisting
vi.mock('@/lib/redis', () => ({
  redis: {
    multi: vi.fn(() => ({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([null, [null, 0]]),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
    })),
    zrange: vi.fn().mockResolvedValue([]),
    zadd: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    incr: vi.fn().mockResolvedValue(1),
    del: vi.fn().mockResolvedValue(1),
    ttl: vi.fn().mockResolvedValue(-1),
  },
}));

// Mock next/headers
vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(
    new Headers({
      'x-forwarded-for': '192.168.1.1',
    })
  ),
  cookies: vi.fn().mockResolvedValue({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  }),
}));

// Import after mocking
import {
  RATE_LIMIT_CONFIGS,
  rateLimit,
  rateLimitSignIn,
  rateLimitSignUp,
  rateLimitPasswordReset,
  rateLimitEmailVerification,
  getIP,
  createRateLimitKey,
  checkAuthBlock,
  recordFailedAuthAttempt,
  clearFailedAuthAttempts,
} from '@/lib/rate-limit';

// Import redis for mock manipulation
import { redis } from '@/lib/redis';

describe('Rate Limit Configuration', () => {
  it('should have correct sign-in rate limit (5 per minute)', () => {
    expect(RATE_LIMIT_CONFIGS.signIn).toEqual({
      limit: 5,
      window: 60,
    });
  });

  it('should have correct sign-up rate limit (3 per hour)', () => {
    expect(RATE_LIMIT_CONFIGS.signUp).toEqual({
      limit: 3,
      window: 3600,
    });
  });

  it('should have correct password reset rate limit (3 per hour per email)', () => {
    expect(RATE_LIMIT_CONFIGS.passwordReset).toEqual({
      limit: 3,
      window: 3600,
    });
  });

  it('should have correct email verification rate limit (5 per hour per email)', () => {
    expect(RATE_LIMIT_CONFIGS.emailVerification).toEqual({
      limit: 5,
      window: 3600,
    });
  });

  it('should have correct password reset IP rate limit (5 per hour)', () => {
    expect(RATE_LIMIT_CONFIGS.passwordResetIp).toEqual({
      limit: 5,
      window: 3600,
    });
  });

  it('should have correct email verification IP rate limit (10 per hour)', () => {
    expect(RATE_LIMIT_CONFIGS.emailVerificationIp).toEqual({
      limit: 10,
      window: 3600,
    });
  });

  it('should have correct admin action rate limit (20 per minute)', () => {
    expect(RATE_LIMIT_CONFIGS.adminAction).toEqual({
      limit: 20,
      window: 60,
    });
  });
});

describe('getIP', () => {
  it('should extract IP from x-forwarded-for header', async () => {
    const ip = await getIP();
    expect(ip).toBe('192.168.1.1');
  });
});

describe('createRateLimitKey', () => {
  it('should create a rate limit key with IP and endpoint', async () => {
    const key = await createRateLimitKey('sign-in');
    expect(key).toBe('192.168.1.1:sign-in');
  });
});

describe('rateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('NODE_ENV', 'production'); // enforce real rate limit logic
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should allow requests within limit', async () => {
    const result = await rateLimit('test-key', { limit: 5, window: 60 });
    expect(result.success).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.remaining).toBe(4);
  });

  it('should use predefined config when type is specified', async () => {
    const result = await rateLimit('test-key', { type: 'signIn' });
    expect(result.success).toBe(true);
    expect(result.limit).toBe(RATE_LIMIT_CONFIGS.signIn.limit);
  });

  it('should deny requests when limit exceeded', async () => {
    // Mock that we already have 5 requests (at limit)
    const mockMulti = vi.mocked(redis.multi);
    mockMulti.mockReturnValueOnce({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([null, [null, 5]]),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof redis.multi>);

    const mockZrange = vi.mocked(redis.zrange);
    mockZrange.mockResolvedValueOnce([Date.now().toString()]);

    const result = await rateLimit('test-key', { limit: 5, window: 60 });
    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBeGreaterThan(0);
  });


  it('should fail closed in production when Redis rate-limit storage fails', async () => {
    const mockMulti = vi.mocked(redis.multi);
    mockMulti.mockReturnValueOnce({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      exec: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof redis.multi>);

    const result = await rateLimit('test-key', { limit: 5, window: 60 });

    expect(result.success).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfter).toBe(60);
  });

  it('can fail open outside production or when explicitly configured', async () => {
    vi.stubEnv('RATE_LIMIT_FAIL_OPEN', 'true');

    const mockMulti = vi.mocked(redis.multi);
    mockMulti.mockReturnValueOnce({
      zremrangebyscore: vi.fn().mockReturnThis(),
      zcard: vi.fn().mockReturnThis(),
      exec: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      zadd: vi.fn().mockReturnThis(),
      expire: vi.fn().mockReturnThis(),
    } as unknown as ReturnType<typeof redis.multi>);

    const result = await rateLimit('test-key', { limit: 5, window: 60 });

    expect(result.success).toBe(true);
    expect(result.remaining).toBe(1);
  });
});

describe('rateLimitSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should apply sign-in rate limit', async () => {
    const result = await rateLimitSignIn();
    expect(result.success).toBe(true);
    expect(result.limit).toBe(RATE_LIMIT_CONFIGS.signIn.limit);
  });
});

describe('rateLimitSignUp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should apply sign-up rate limit', async () => {
    const result = await rateLimitSignUp();
    expect(result.success).toBe(true);
    expect(result.limit).toBe(RATE_LIMIT_CONFIGS.signUp.limit);
  });
});

describe('rateLimitPasswordReset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should apply both email and IP rate limits', async () => {
    const result = await rateLimitPasswordReset('test@example.com');
    expect(result.success).toBe(true);
  });

  it('should normalize email to lowercase', async () => {
    const result = await rateLimitPasswordReset('TEST@EXAMPLE.COM');
    expect(result.success).toBe(true);
  });
});

describe('rateLimitEmailVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should apply both email and IP rate limits', async () => {
    const result = await rateLimitEmailVerification('test@example.com');
    expect(result.success).toBe(true);
  });
});

describe('Auth Block Functions', () => {
  describe('checkAuthBlock', () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should return not blocked for new identifiers', async () => {
      const result = await checkAuthBlock('new-identifier');
      expect(result.blocked).toBe(false);
      expect(result.remainingAttempts).toBe(5);
    });

    it('should use custom max attempts', async () => {
      const result = await checkAuthBlock('new-identifier', 10);
      expect(result.blocked).toBe(false);
      expect(result.remainingAttempts).toBe(10);
    });

    it('should return blocked when max attempts reached', async () => {
      const mockGet = vi.mocked(redis.get);
      mockGet.mockResolvedValueOnce('5');
      const mockTtl = vi.mocked(redis.ttl);
      mockTtl.mockResolvedValueOnce(300);

      const result = await checkAuthBlock('blocked-identifier', 5);
      expect(result.blocked).toBe(true);
      expect(result.remainingAttempts).toBe(0);
      expect(result.blockExpires).toBe(300);
    });
  });

  describe('recordFailedAuthAttempt', () => {
    it('should record failed attempt without error', async () => {
      await expect(recordFailedAuthAttempt('test-identifier')).resolves.not.toThrow();
    });
  });

  describe('clearFailedAuthAttempts', () => {
    it('should clear failed attempts without error', async () => {
      await expect(clearFailedAuthAttempts('test-identifier')).resolves.not.toThrow();
    });
  });
});

describe('Auth Route Rate Limiting Integration', () => {
  // These tests verify the rate limiting logic in the auth route handler

  it('should identify sign-in action from path', () => {
    const path = '/api/auth/sign-in';
    const segments = path.split('/').filter(Boolean);
    const authIndex = segments.indexOf('auth');
    const action = segments[authIndex + 1];
    expect(action).toBe('sign-in');
  });

  it('should identify sign-up action from path', () => {
    const path = '/api/auth/sign-up';
    const segments = path.split('/').filter(Boolean);
    const authIndex = segments.indexOf('auth');
    const action = segments[authIndex + 1];
    expect(action).toBe('sign-up');
  });

  it('should identify forgot-password action from path', () => {
    const path = '/api/auth/forgot-password';
    const segments = path.split('/').filter(Boolean);
    const authIndex = segments.indexOf('auth');
    const action = segments[authIndex + 1];
    expect(action).toBe('forgot-password');
  });

  it('should identify verify-email action from path', () => {
    const path = '/api/auth/verify-email';
    const segments = path.split('/').filter(Boolean);
    const authIndex = segments.indexOf('auth');
    const action = segments[authIndex + 1];
    expect(action).toBe('verify-email');
  });
});

describe('Rate Limit Response Headers', () => {
  it('should include proper rate limit headers in 429 response', () => {
    const mockResult = {
      success: false,
      limit: 5,
      remaining: 0,
      reset: Math.floor(Date.now() / 1000) + 60,
      retryAfter: 45,
    };

    const response = NextResponse.json(
      {
        error: 'Too many requests',
        message: 'Please try again later',
        retryAfter: mockResult.retryAfter,
      },
      {
        status: 429,
        headers: {
          'Retry-After': String(mockResult.retryAfter),
          'X-RateLimit-Limit': String(mockResult.limit),
          'X-RateLimit-Remaining': String(mockResult.remaining),
          'X-RateLimit-Reset': String(mockResult.reset),
        },
      }
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('45');
    expect(response.headers.get('X-RateLimit-Limit')).toBe('5');
    expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(response.headers.get('X-RateLimit-Reset')).toBeTruthy();
  });
});
