import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { LEGACY_PERMISSION_ALIASES } from '../src/lib/auth/permission-constants';

const ROOT = process.cwd();
const RUNTIME_ROOTS = ['src/app', 'src/lib', 'src/workers'];
const LEGACY_VALUES = Object.keys(LEGACY_PERMISSION_ALIASES);
const EXCLUDED_SEGMENTS = new Set(['__tests__', 'test-results', 'playwright-report']);
const EXCLUDED_FILES = new Set([
  'src/lib/auth/permission-constants.ts',
  'src/lib/auth/__tests__/permissions-enhanced.test.ts',
  'src/lib/auth/__tests__/permissions-integration.test.ts',
  'src/lib/auth/__tests__/permissions.test.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${entry}`.replaceAll('\\\\', '/');
    if (rel.split('/').some((part) => EXCLUDED_SEGMENTS.has(part))) continue;

    const absolute = join(ROOT, rel);
    const stat = statSync(absolute);
    if (stat.isDirectory()) {
      walk(rel, out);
      continue;
    }

    if (!rel.endsWith('.ts') && !rel.endsWith('.tsx')) continue;
    if (EXCLUDED_FILES.has(rel)) continue;
    out.push(rel);
  }
  return out;
}

const violations: Array<{ file: string; line: number; value: string }> = [];

for (const root of RUNTIME_ROOTS) {
  for (const file of walk(root)) {
    const contents = readFileSync(join(ROOT, file), 'utf8');
    const lines = contents.split(/\r?\n/);
    for (const legacyPermission of LEGACY_VALUES) {
      const singleQuoted = `'${legacyPermission}'`;
      const doubleQuoted = `"${legacyPermission}"`;
      lines.forEach((line, index) => {
        if (line.includes(singleQuoted) || line.includes(doubleQuoted)) {
          violations.push({ file: relative(ROOT, join(ROOT, file)), line: index + 1, value: legacyPermission });
        }
      });
    }
  }
}

if (violations.length > 0) {
  console.error('Legacy colon-style permissions were found in runtime source files.');
  console.error('Import constants from src/lib/auth/permission-constants.ts instead.');
  for (const violation of violations) {
    console.error(`- ${violation.file}:${violation.line} uses ${violation.value}`);
  }
  process.exit(1);
}

console.log('Canonical permission audit passed: no legacy permission strings in runtime source.');
