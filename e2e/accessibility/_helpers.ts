/**
 * Shared axe-core harness for the WCAG 2.1 AA accessibility suite.
 *
 * Design rules (deliberate, so nobody "fixes" them into a false green):
 *  - We scan with explicit WCAG 2.1 A/AA tags so findings map to what
 *    docs/ACCESSIBILITY.md actually claims the project targets.
 *  - We FAIL on `serious` and `critical` impact only. Moderate/minor findings
 *    are still printed and attached to the report, but do not fail the build.
 *    Rationale: WCAG 2.1 AA conformance is binary, but axe impact is a proxy
 *    for how badly a rule breaks the page, and the project's stated bar in
 *    docs/ACCESSIBILITY.md is the AA checklist. Serious/critical findings are
 *    the ones that block a member from operating the portal at all.
 *  - We never call test.skip / test.fixme / test.todo, and we never pass a
 *    blanket `disableRules`. A red suite is a valid outcome.
 *  - The allowlist below is for KNOWN FALSE POSITIVES ONLY. Every entry must
 *    carry a comment explaining why axe is wrong. It is not a place to park
 *    real violations (colour contrast in particular is reported, not hidden).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, type TestInfo } from '@playwright/test';

// NOTE: `test` is deliberately NOT re-exported from here. Re-exporting the test
// object from a helper module breaks Playwright's fixture type inference in the
// consuming spec files (it resolves to the untyped `any` overload), which
// `npm run typecheck` correctly rejects. Specs import `test` from
// '@playwright/test' directly, matching the rest of e2e/.

/** Tags asserted by this project per docs/ACCESSIBILITY.md (WCAG 2.1 AA). */
export const WCAG_AA_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

/** Impact levels that fail the build. */
export const FAILING_IMPACTS = ['serious', 'critical'] as const;

export type AxeImpact = 'minor' | 'moderate' | 'serious' | 'critical';

/**
 * Rules that axe reports but which are demonstrably not violations here.
 * EMPTY BY DEFAULT AND INTENTIONALLY KEPT EMPTY unless a rule is proven wrong.
 */
export const KNOWN_FALSE_POSITIVES: ReadonlyArray<{ ruleId: string; reason: string }> = [
  // Intentionally empty. Add entries only with a written justification for why
  // axe is incorrect, never to silence a genuine WCAG 2.1 AA failure.
];

/** WCAG success-criterion number for a rule, derived from axe's wcag tags. */
function successCriteria(ruleId: string, tags: readonly string[]): string {
  const wcagTags = tags
    .filter((t) => /^wcag\d+$/.test(t))
    .map((t) => {
      const digits = t.replace('wcag', '');
      return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
    });
  if (wcagTags.length === 0) return 'no WCAG SC mapped by axe (best-practice rule)';
  return `${wcagTags.join(', ')}  [${ruleId}]`;
}

export interface Finding {
  surface: string;
  url: string;
  ruleId: string;
  impact: AxeImpact;
  wcag: string;
  help: string;
  helpUrl: string;
  description: string;
  selector: string;
  snippet: string;
  failureSummary: string;
}

function selectorOf(node: { target?: unknown }): string {
  const t = node.target;
  if (Array.isArray(t)) return t.map(String).join(' >> ');
  return typeof t === 'string' ? t : '(no target reported)';
}

function severityOrder(i: AxeImpact): number {
  return { minor: 0, moderate: 1, serious: 2, critical: 3 }[i];
}

/** Human-readable, copy-pasteable report block. */
export function formatFindings(findings: readonly Finding[]): string {
  if (findings.length === 0) return 'No WCAG 2.1 AA violations detected.';
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byRule.get(f.ruleId) ?? [];
    list.push(f);
    byRule.set(f.ruleId, list);
  }
  const lines: string[] = [];
  for (const [ruleId, group] of [...byRule.entries()].sort(
    (a, b) => severityOrder(b[1][0].impact) - severityOrder(a[1][0].impact),
  )) {
    const head = group[0];
    lines.push('');
    lines.push(
      `  [${head.impact.toUpperCase()}] ${ruleId} — WCAG SC ${head.wcag}`,
    );
    lines.push(`    What: ${head.help}`);
    lines.push(`    Why: ${head.description}`);
    lines.push(`    Docs: ${head.helpUrl}`);
    lines.push(`    Occurrences on ${head.surface} (${head.url}): ${group.length}`);
    const shown = group.slice(0, 10);
    for (const f of shown) {
      lines.push(`      - selector: ${f.selector}`);
      lines.push(`        html:    ${f.snippet}`);
      if (f.failureSummary) {
        for (const fl of f.failureSummary.split('\n')) lines.push(`        ${fl}`);
      }
    }
    if (group.length > shown.length) {
      lines.push(`      ... and ${group.length - shown.length} more occurrence(s)`);
    }
  }
  return lines.join('\n');
}

/** Counts by impact, for the summary line. */
export function countByImpact(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = { minor: 0, moderate: 0, serious: 0, critical: 0 };
  for (const f of findings) counts[f.impact] = (counts[f.impact] ?? 0) + 1;
  return counts;
}

/**
 * Scan a page with axe-core, report everything, fail on serious/critical.
 *
 * `surface` is the human label used in the report (e.g. "public homepage").
 */
export async function scanSurface(
  page: Page,
  testInfo: TestInfo,
  surface: string,
  options: { includeBestPractice?: boolean } = {},
): Promise<Finding[]> {
  const scanPage = page;

  let builder = new AxeBuilder({ page: scanPage }).withTags([...WCAG_AA_TAGS]);
  if (options.includeBestPractice) builder = builder.withTags(['best-practice']);

  const results = await builder.analyze();
  const url = scanPage.url();

  const allowed = new Map(KNOWN_FALSE_POSITIVES.map((e) => [e.ruleId, e.reason]));
  const findings: Finding[] = [];

  for (const violation of results.violations) {
    if (allowed.has(violation.id)) {
      console.log(`  ⓘ  ${violation.id} suppressed as a KNOWN FALSE POSITIVE: ${allowed.get(violation.id)}`);
      continue;
    }
    const impact = (violation.impact ?? 'minor') as AxeImpact;
    for (const node of violation.nodes) {
      findings.push({
        surface,
        url,
        ruleId: violation.id,
        impact,
        wcag: successCriteria(violation.id, violation.tags),
        help: violation.help,
        helpUrl: violation.helpUrl,
        description: violation.description,
        selector: selectorOf(node),
        snippet: (node.html ?? '').slice(0, 300),
        failureSummary: node.failureSummary ?? '',
      });
    }
  }

  const counts = countByImpact(findings);
  const blocking = findings.filter((f) =>
    (FAILING_IMPACTS as readonly string[]).includes(f.impact),
  );
  const advisory = findings.filter(
    (f) => !(FAILING_IMPACTS as readonly string[]).includes(f.impact),
  );

  console.log(
    `\n=== axe-core: ${surface} (${url}) ===\n` +
      `WCAG 2.1 A/AA violations — critical: ${counts.critical}, serious: ${counts.serious}, ` +
      `moderate: ${counts.moderate}, minor: ${counts.minor}\n` +
      `FAIL threshold: ${FAILING_IMPACTS.join(', ')} (${blocking.length} blocking, ` +
      `${advisory.length} reported-only)`,
  );
  console.log(formatFindings(findings));

  await testInfo.attach(`a11y-${surface.replace(/\s+/g, '-')}-wcag21aa`, {
    body: Buffer.from(
      JSON.stringify(
        { surface, url, counts, findings },
        null,
        2,
      ),
    ),
    contentType: 'application/json',
  });

  expect(
    blocking,
    `${surface}: ${blocking.length} serious/critical WCAG 2.1 AA violation(s).\n` +
      `Fail threshold is impact in [${FAILING_IMPACTS.join(', ')}]. Moderate/minor are reported above.\n` +
      formatFindings(blocking),
  ).toHaveLength(0);

  return findings;
}

/**
 * Navigate and assert we actually landed on the surface (guards against a
 * silent redirect to /login turning an authenticated scan into a false green).
 */
export async function gotoSurface(
  page: Page,
  route: string,
  opts: { expectAuthenticated?: boolean } = {},
): Promise<void> {
  const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
  expect(response, `${route} should return a response`).not.toBeNull();
  expect(response!.status(), `${route} should not return a server error`).toBeLessThan(500);
  await expect(page.locator('body')).toBeVisible();

  if (opts.expectAuthenticated) {
    expect(
      page.url(),
      `${route} redirected to a login/unauthenticated page — the authenticated scan would be meaningless`,
    ).not.toContain('/login');
  }

  // Let fonts, hydration and entrance animations settle so axe measures the
  // settled DOM rather than a half-painted one.
  await page.waitForLoadState('load').catch(() => undefined);
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
  await waitForAnimationsToSettle(page);
}

/**
 * Wait until the page's animations have finished.
 *
 * This is a MEASUREMENT-STABILITY fix, not a way to hide findings. This app
 * animates hero CTAs in with GSAP (scale/opacity/translate). axe-core resolves
 * colours and geometry from computed style mid-animation, so scanning too early
 * produced a genuinely FLAKY result — the same homepage reported 2 serious
 * colour-contrast violations on one run and 0 on the next, with no code change.
 * The violations were real in the settled state; we just want to measure that
 * state deterministically. Contrast bugs that exist only mid-animation would be
 * invisible to a real user anyway, so they are not what this suite is for.
 */
async function waitForAnimationsToSettle(page: Page, timeoutMs = 8000): Promise<void> {
  await page
    .evaluate(async (budgetMs) => {
      const animations = document.getAnimations?.() ?? [];
      const running = animations.filter((a) => a.playState === 'running');
      if (running.length === 0) return;
      await Promise.race([
        Promise.allSettled(running.map((a) => a.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, budgetMs)),
      ]);
    }, timeoutMs)
    .catch(() => undefined);
}