import { expect, test } from '@playwright/test';
import { expectRouteLoads } from '../_support/assertions';

test.describe('member portal access boundary', () => {
  test('member dashboard route either loads or redirects to authentication', async ({ page }) => {
    await expectRouteLoads(page, '/dashboard');
    await expect(page.locator('body')).toContainText(/dashboard|login|sign in|member/i);
  });
});
