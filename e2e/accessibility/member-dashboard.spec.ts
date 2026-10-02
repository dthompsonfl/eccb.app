/**
 * Authenticated-surface WCAG 2.1 AA scan: the member dashboard.
 *
 * Authentication reuses the existing storage-state mechanism — the `setup`
 * project (e2e/auth.setup.ts) writes e2e/.auth/admin.json and this spec runs in
 * the `accessibility` project, which loads that same state file and declares
 * `dependencies: ['setup']`. No second login flow is invented here.
 *
 * /dashboard is the documented member entry point; the route currently
 * redirects to /member, so the scan follows the redirect and asserts we did not
 * land on /login (which would make the scan meaningless).
 */
import { expect, test } from '@playwright/test';
import { gotoSurface, scanSurface } from './_helpers';

test.describe('authenticated accessibility — member dashboard', () => {
  test('member dashboard has no serious or critical WCAG 2.1 AA violations', async ({
    page,
  }, testInfo) => {
    await gotoSurface(page, '/dashboard', { expectAuthenticated: true });
    await expect(page.locator('html')).toHaveAttribute('lang', /.+/);
    await scanSurface(page, testInfo, 'member dashboard');
  });

  test('member dashboard landing page (/member) has no serious or critical violations', async ({
    page,
  }, testInfo) => {
    await gotoSurface(page, '/member', { expectAuthenticated: true });
    await scanSurface(page, testInfo, 'member area landing');
  });
});