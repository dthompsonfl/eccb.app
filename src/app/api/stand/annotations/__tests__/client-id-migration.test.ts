import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The offline annotation queue promises that a replayed stroke cannot be stored
 * twice. That promise is enforced by a database constraint, so a schema change
 * that drops or weakens the constraint would silently restore the duplicate —
 * with no TypeScript error and no failing unit test, because the behaviour lives
 * in MariaDB, not in the application.
 *
 * This test pins the migration and the schema together so the guarantee cannot
 * be removed unnoticed.
 */

const ROOT = process.cwd();
const MIGRATION =
  'prisma/migrations/20261004120000_annotation_client_id/migration.sql';
const SCHEMA = 'prisma/schema.prisma';

describe('Annotation clientId idempotency constraint', () => {
  it('migration adds a nullable clientId column', () => {
    const sql = readFileSync(join(ROOT, MIGRATION), 'utf8');
    expect(sql).toMatch(/ADD COLUMN\s+`clientId`\s+VARCHAR\(64\)\s+NULL/i);
  });

  it('migration creates the unique index on (userId, clientId)', () => {
    const sql = readFileSync(join(ROOT, MIGRATION), 'utf8');
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX[\s\S]*`Annotation_userId_clientId_key`[\s\S]*ON `Annotation`\s*\(`userId`,\s*`clientId`\)/i,
    );
  });

  it('schema declares the matching unique constraint', () => {
    const schema = readFileSync(join(ROOT, SCHEMA), 'utf8');
    const model = schema.slice(
      schema.indexOf('model Annotation {'),
      schema.indexOf('model NavigationLink {'),
    );
    expect(model).toMatch(/@@unique\(\[userId, clientId\]\)/);
  });

  it('schema keeps clientId nullable so online writes are exempt', () => {
    const schema = readFileSync(join(ROOT, SCHEMA), 'utf8');
    const model = schema.slice(
      schema.indexOf('model Annotation {'),
      schema.indexOf('model NavigationLink {'),
    );
    // A default here would fabricate an id for every annotation and make
    // unrelated strokes collide on the unique index.
    expect(model).toMatch(/clientId\s+String\?/);
    expect(model).not.toMatch(/clientId\s+String\?.*@default/);
  });
});