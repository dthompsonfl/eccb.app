import { redis } from './redis';
import { headers } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';

/**
 * Rate limit configuration for different endpoint types
 */
export const RATE_LIMIT_CONFIGS = {
  // Authentication endpoints - strict limit
  auth: { limit: 5, window: 60 },        // 5 requests per minute
  // Contact form - prevent spam
  contact: { limit: 5, window: 3600 },   // 5 requests per hour
  // File downloads - moderate limit
  files: { limit: 30, window: 60 },      // 30 requests per minute
  // File uploads - stricter limit
  upload: { limit: 10, window: 60 },     // 10 uploads per minute
  // RSVP - prevent abuse
  rsvp: { limit: 10, window: 60 },       // 10 requests per minute
  // General API - standard limit
  api: { limit: 100, window: 60 },       // 100 requests per minute
  // Static assets - generous limit
  static: { limit: 1000, window: 60 },   // 1000 requests per minute
  // Password reset - 3 requests per email per hour
  passwordReset: { limit: 3, window: 3600 },
  // Password reset per IP - 5 requests per IP per hour
  passwordResetIp: { limit: 5, window: 3600 },
  // Email verification - 5 requests per email per hour
  emailVerification: { limit: 5, window: 3600 },
  // Email verification per IP - 10 requests per IP per hour
  emailVerificationIp: { limit: 10, window: 3600 },
  // Sign up - 3 per IP per hour (prevent spam accounts)
  signUp: { limit: 3, window: 3600 },
  // Sign in - 5 per minute per IP (prevent brute force)
  signIn: { limit: 5, window: 60 },
  // Admin actions - sensitive operations like ban, delete, impersonate
  adminAction: { limit: 20, window: 60 }, // 20 per minute
  // Smart upload - stricter limit for AI processing
  'smart-upload': { limit: 5, window: 60 }, // 5 uploads per minute
  // Second pass - moderate limit for additional AI processing
  'second-pass': { limit: 10, window: 60 }, // 10 requests per minute
  // Stand annotation CRUD - generous but bounded
  'stand-annotation': { limit: 60, window: 60 }, // 60 per minute
  // Stand file proxy - moderate limit
  'stand-file': { limit: 120, window: 60 }, // 120 per minute
  // Stand sync polling
  'stand-sync': { limit: 120, window: 60 }, // 120 per minute
  // Stand preferences writes
  'stand-preferences': { limit: 30, window: 60 }, // 30 per minute
  // Stand practice log writes
  'stand-practice': { limit: 30, window: 60 }, // 30 per minute
} as const;

export type RateLimitType = keyof typeof RATE_LIMIT_CONFIGS;

interface RateLimitOptions {
  limit?: number;
  window?: number; // in seconds
  type?: RateLimitType;
}

interface RateLimitResult {
  success: boolean;
  limit: number;
  remaining: number;
  reset: number;
  retryAfter?: number;
}

function isRateLimitBypassed(): boolean {
  return process.env.NODE_ENV !== 'production';
}

/**
 * Sliding window rate limiting using Redis
 * 
 * This implements a sliding window algorithm that provides more accurate
 * rate limiting than fixed windows by tracking request timestamps.
 * 
 * @param key - Unique identifier for the rate limit (e.g., IP + endpoint)
 * @param options - Rate limit configuration
 * @returns RateLimitResult with success status and metadata
 */
export async function rateLimit(
  key: string,
  options: RateLimitOptions = {}
): Promise<RateLimitResult> {
  if (isRateLimitBypassed()) {
    const config = options.type
      ? RATE_LIMIT_CONFIGS[options.type]
      : { limit: options.limit ?? 100, window: options.window ?? 60 };

    return {
      success: true,
      limit: config.limit,
      remaining: config.limit,
      reset: Math.floor((Date.now() + (config.window * 1000)) / 1000),
    };
  }

  // Use predefined config if type is specified
  const config = options.type 
    ? RATE_LIMIT_CONFIGS[options.type]
    : { limit: options.limit ?? 100, window: options.window ?? 60 };
  
  const { limit, window } = config;
  const now = Date.now();
  const windowStart = now - (window * 1000);
  const redisKey = `rate-limit:${key}`;

  try {
    // Use Redis transaction for atomic operations
    const multi = redis.multi();
    
    // Remove old entries outside the window
    multi.zremrangebyscore(redisKey, '-inf', windowStart);
    
    // Count current entries in the window
    multi.zcard(redisKey);
    
    // Execute the transaction
    const results = await multi.exec();
    
    if (!results) {
      throw new Error('Redis transaction failed');
    }
    
    // Get the count from the second command
    const count = results[1]?.[1] as number ?? 0;
    
    // Calculate reset time
    const reset = Math.floor((now + (window * 1000)) / 1000);
    
    // Check if limit exceeded
    if (count >= limit) {
      // Get the oldest entry to calculate retry-after
      const oldestEntries = await redis.zrange(redisKey, 0, 0, 'WITHSCORES');
      const oldestTimestamp = oldestEntries[1] ? parseInt(oldestEntries[1]) : now;
      const retryAfter = Math.ceil((oldestTimestamp + (window * 1000) - now) / 1000);
      
      return {
        success: false,
        limit,
        remaining: 0,
        reset,
        retryAfter: Math.max(1, retryAfter),
      };
    }
    
    // Add current request to the sorted set with timestamp as score
    await redis.zadd(redisKey, now, `${now}-${crypto.randomUUID()}`);
    
    // Set expiry on the key
    await redis.expire(redisKey, window);
    
    return {
      success: true,
      limit,
      remaining: limit - count - 1,
      reset,
    };
  } catch (error) {
    console.error('Rate limit error:', error);

    const failOpen = process.env.RATE_LIMIT_FAIL_OPEN === 'true' || process.env.NODE_ENV !== 'production';
    if (failOpen) {
      return {
        success: true,
        limit,
        remaining: 1,
        reset: Math.floor((now + (window * 1000)) / 1000),
      };
    }

    return {
      success: false,
      limit,
      remaining: 0,
      reset: Math.floor((now + (window * 1000)) / 1000),
      retryAfter: Math.min(window, 60),
    };
  }
}

/**
 * Get client IP from request headers
 */
export async function getIP(): Promise<string> {
  const headersList = await headers();
  const forwardedFor = headersList.get('x-forwarded-for');
  if (forwardedFor) {
    return forwardedFor.split(',')[0].trim();
  }
  const realIP = headersList.get('x-real-ip');
  if (realIP) {
    return realIP;
  }
  return '127.0.0.1';
}

/**
 * Create a rate limit key combining IP and endpoint
 */
export async function createRateLimitKey(endpoint: string): Promise<string> {
  const ip = await getIP();
  return `${ip}:${endpoint}`;
}

/**
 * Rate limit middleware helper for API routes
 * 
 * @param request - The incoming request
 * @param type - The rate limit type to apply
 * @returns null if allowed, or NextResponse with 429 error
 */
export async function applyRateLimit(
  request: NextRequest,
  type: RateLimitType
): Promise<NextResponse | null> {
  const key = await createRateLimitKey(type);
  const result = await rateLimit(key, { type });
  
  if (!result.success) {
    return NextResponse.json(
      { 
        error: 'Too many requests',
        message: 'Please try again later',
        retryAfter: result.retryAfter,
      },
      { 
        status: 429,
        headers: {
          'Retry-After': String(result.retryAfter ?? 60),
          'X-RateLimit-Limit': String(result.limit),
          'X-RateLimit-Remaining': String(result.remaining),
          'X-RateLimit-Reset': String(result.reset),
        },
      }
    );
  }
  
  return null;
}

/**
 * Add rate limit headers to a response
 */
export function addRateLimitHeaders(
  response: NextResponse,
  result: RateLimitResult
): NextResponse {
  response.headers.set('X-RateLimit-Limit', String(result.limit));
  response.headers.set('X-RateLimit-Remaining', String(result.remaining));
  response.headers.set('X-RateLimit-Reset', String(result.reset));
  return response;
}

/**
 * Auth-specific rate limiting utilities
 */

/**
 * Rate limit password reset requests
 * Implements both per-email and per-IP limits
 * 
 * @param email - The email address requesting reset
 * @returns RateLimitResult indicating if request is allowed
 */
export async function rateLimitPasswordReset(email: string): Promise<RateLimitResult> {
  const ip = await getIP();
  
  // Check per-email limit first
  const emailKey = `password-reset:email:${email.toLowerCase()}`;
  const emailResult = await rateLimit(emailKey, { type: 'passwordReset' });
  
  if (!emailResult.success) {
    return {
      ...emailResult,
      retryAfter: emailResult.retryAfter,
    };
  }
  
  // Check per-IP limit
  const ipKey = `password-reset:ip:${ip}`;
  const ipResult = await rateLimit(ipKey, { type: 'passwordResetIp' });
  
  return ipResult;
}

/**
 * Rate limit email verification requests
 * Implements both per-email and per-IP limits
 * 
 * @param email - The email address to verify
 * @returns RateLimitResult indicating if request is allowed
 */
export async function rateLimitEmailVerification(email: string): Promise<RateLimitResult> {
  const ip = await getIP();
  
  // Check per-email limit first
  const emailKey = `email-verification:email:${email.toLowerCase()}`;
  const emailResult = await rateLimit(emailKey, { type: 'emailVerification' });
  
  if (!emailResult.success) {
    return emailResult;
  }
  
  // Check per-IP limit
  const ipKey = `email-verification:ip:${ip}`;
  const ipResult = await rateLimit(ipKey, { type: 'emailVerificationIp' });
  
  return ipResult;
}

/**
 * Rate limit sign in attempts
 * Per-IP rate limiting to prevent brute force
 * 
 * @returns RateLimitResult indicating if request is allowed
 */
export async function rateLimitSignIn(): Promise<RateLimitResult> {
  const key = await createRateLimitKey('sign-in');
  return rateLimit(key, { type: 'signIn' });
}

/**
 * Rate limit sign up attempts
 * Per-IP rate limiting to prevent spam accounts
 * 
 * @returns RateLimitResult indicating if request is allowed
 */
export async function rateLimitSignUp(): Promise<RateLimitResult> {
  const key = await createRateLimitKey('sign-up');
  return rateLimit(key, { type: 'signUp' });
}

/**
 * Check if an IP is temporarily blocked due to failed auth attempts
 * This can be used to implement progressive delays
 * 
 * @param identifier - Unique identifier (e.g., email or IP)
 * @param maxAttempts - Maximum failed attempts before block
 * @param blockDuration - Block duration in seconds
 */
export async function checkAuthBlock(
  identifier: string,
  maxAttempts: number = 5,
  blockDuration: number = 900 // 15 minutes
): Promise<{ blocked: boolean; remainingAttempts: number; blockExpires?: number }> {
  const key = `auth-block:${identifier}`;
  
  try {
    const count = await redis.get(key);
    const attempts = parseInt(count || '0');
    
    if (attempts >= maxAttempts) {
      const ttl = await redis.ttl(key);
      return {
        blocked: true,
        remainingAttempts: 0,
        blockExpires: ttl > 0 ? ttl : blockDuration,
      };
    }
    
    return {
      blocked: false,
      remainingAttempts: maxAttempts - attempts,
    };
  } catch {
    return {
      blocked: false,
      remainingAttempts: maxAttempts,
    };
  }
}

/**
 * Record a failed auth attempt
 * 
 * @param identifier - Unique identifier (e.g., email or IP)
 * @param windowSeconds - Time window for counting attempts
 */
export async function recordFailedAuthAttempt(
  identifier: string,
  windowSeconds: number = 900 // 15 minutes
): Promise<void> {
  const key = `auth-block:${identifier}`;
  
  try {
    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSeconds);
    }
  } catch (error) {
    console.error('Failed to record auth attempt:', error);
  }
}

/**
 * Clear failed auth attempts (on successful login)
 * 
 * @param identifier - Unique identifier to clear
 */
export async function clearFailedAuthAttempts(identifier: string): Promise<void> {
  const key = `auth-block:${identifier}`;
  
  try {
    await redis.del(key);
  } catch (error) {
    console.error('Failed to clear auth attempts:', error);
  }
}
