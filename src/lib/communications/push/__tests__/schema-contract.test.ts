/**
 * Schema and migration contract tests.
 *
 * These read prisma/schema.prisma and the migration SQL as TEXT. That looks
 * unusual next to the behavioural tests, and it is deliberate.
 *
 * A unit test with a mocked Prisma client cannot observe a column DEFAULT: the
 * mock answers whatever the test tells it to. Flipping `pushEnabled` to
 * `@default(true)` in the schema therefore leaves every behavioural test in
 * this directory green while enrolling every existing member in push on the
 * next migration — the single worst mutation available in this feature, and one
 * the behavioural suite genuinely cannot catch.
 *
 * The database default is the LAST line of defence for an opt-in feature, so it
 * gets its own test. Same reasoning covers the endpoint uniqueness constraint
 * and the migration SQL: if the migration and the schema drift apart, the
 * constraint the code relies on does not exist in the real database even though
 * the Prisma types still claim it does.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCHEMA_PATH = join(process.cwd(), 'prisma', 'schema.prisma');
const MIGRATION_PATH = join(
  process.cwd(),
  'prisma',
  'migrations',
  '20261003120000_push_subscriptions',
  'migration.sql',
);

const schema = readFileSync(SCHEMA_PATH, 'utf-8');
const migration = readFileSync(MIGRATION_PATH, 'utf-8');

/** Extract the body of a `model X { ... }` block. */
function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  expect(start, `model ${name} not found in schema.prisma`).toBeGreaterThan(-1);
  const end = schema.indexOf('\n}', start);
  return schema.slice(start, end);
}

describe('push schema contract', () => {
  describe('UserPreferences.pushEnabled', () => {
    it('is declared DEFAULT FALSE', () => {
      const block = modelBlock('UserPreferences');

      expect(block).toMatch(/pushEnabled\s+Boolean\s+@default\(false\)/);
      expect(block).not.toMatch(/pushEnabled\s+Boolean\s+@default\(true\)/);
    });

    it('records a separate consent timestamp', () => {
      // pushEnabled alone cannot distinguish "opted out then back in" from
      // "never consented", and carries no Art. 7(1) record of when.
      expect(modelBlock('UserPreferences')).toMatch(/pushConsentedAt\s+DateTime\?/);
    });
  });

  describe('PushSubscription', () => {
    it('makes `endpoint` unique so a browser cannot accumulate duplicates', () => {
      expect(modelBlock('PushSubscription')).toMatch(/endpoint\s+String\s+@unique/);
    });

    it('requires the p256dh and auth key material', () => {
      const block = modelBlock('PushSubscription');
      expect(block).toMatch(/p256dh\s+String/);
      expect(block).toMatch(/auth\s+String/);
    });

    it('cascades deletion from User so an account erase removes its endpoints', () => {
      expect(modelBlock('PushSubscription')).toMatch(
        /user\s+User\s+@relation\([^)]*onDelete: Cascade/s,
      );
    });

    it('is reachable from User', () => {
      expect(modelBlock('User')).toMatch(/pushSubscriptions\s+PushSubscription\[\]/);
    });
  });
});

describe('push migration contract', () => {
  it('adds the consent columns with a FALSE database default', () => {
    // The behavioural suite cannot see this: the Prisma mock answers whatever
    // the test says. This is the assertion that catches a default flip.
    expect(migration).toMatch(
      /ADD COLUMN `pushEnabled` BOOLEAN NOT NULL DEFAULT FALSE/,
    );
    expect(migration).not.toMatch(/pushEnabled` BOOLEAN NOT NULL DEFAULT TRUE/i);
  });

  it('creates the endpoint unique index the upsert depends on', () => {
    expect(migration).toMatch(
      /UNIQUE INDEX `PushSubscription_endpoint_key`\(`endpoint`\)/,
    );
  });

  it('creates the table with a CASCADE foreign key to User', () => {
    expect(migration).toMatch(/CREATE TABLE `PushSubscription`/);
    expect(migration).toMatch(
      /FOREIGN KEY \(`userId`\) REFERENCES `User` \(`id`\) ON DELETE CASCADE/,
    );
  });

  it('matches the schema collation used by every other table', () => {
    expect(migration).toMatch(/COLLATE utf8mb4_unicode_ci/);
  });
});
