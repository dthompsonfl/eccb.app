/**
 * Test helper: set environment values for code under test.
 *
 * The global test setup hard-mocks `@/lib/env` (see test-setup.ts), and
 * production modules read their configuration from that object rather than from
 * `process.env` directly. Mutating `process.env` in a test therefore has no
 * effect on a module that imports `env`.
 *
 * This writes to BOTH so a test works regardless of which the module reads.
 * ALLOWED_ORIGINS and COOKIE_SECURE are absent from the default mock, so they
 * must be added rather than assigned.
 */
import { env } from '@/lib/env';

export function setTestEnv(values: Record<string, string | undefined>): void {
  const target = env as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete target[key];
      delete process.env[key];
    } else {
      target[key] = value;
      process.env[key] = value;
    }
  }
}
