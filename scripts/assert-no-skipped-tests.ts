/**
 * Release gate: fail the build if any test is skipped or marked todo.
 *
 * The scanner itself lives in `src/lib/tools/skip-guard.ts` so Vitest can import
 * and test it (`vitest.config.ts` only collects `src/**`). This was previously a
 * silent no-op: the root path resolved one level too high, the resulting ENOENT
 * was swallowed, and the script exited 0.
 */
import { ROOT, findSkips, type SkipFinding } from '../src/lib/tools/skip-guard';

async function main() {
  console.log('🔍 Checking for skipped/todo tests...');
  console.log(`   root: ${ROOT}`);

  let issues: SkipFinding[];
  try {
    issues = await findSkips();
  } catch (err) {
    console.error('✗ Skip-guard could not scan the repository:', err);
    console.error('  Refusing to report success — fix the path resolution.');
    process.exit(1);
  }

  if (issues.length > 0) {
    console.error('✗ Found skipped/todo patterns:');
    for (const it of issues) {
      console.error(`  ${it.file}:${it.line} -> ${it.match}`);
    }
    process.exit(1);
  }

  console.log('✓ No skipped or todo tests detected.');
  process.exit(0);
}

main().catch((e) => {
  console.error('Error running skip-guard:', e);
  process.exit(1);
});
