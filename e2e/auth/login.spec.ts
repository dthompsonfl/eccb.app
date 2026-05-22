import { expect, test } from '@playwright/test';
import { expectRouteLoads } from '../_support/assertions';

test.describe('authentication', () => {
  test('login page loads and exposes required fields', async ({ page }) => {
    await expectRouteLoads(page, '/login');
    await expect(page.getByLabel(/email/i)).toBeVisible();
    await expect(page.getByLabel(/password/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /sign in|log in|login/i })).toBeVisible();
  });

  test('signup page loads without a server error', async ({ page }) => {
    await expectRouteLoads(page, '/signup');
    await expect(page.locator('body')).toContainText(/sign up|join|account|member/i);
  });
});
