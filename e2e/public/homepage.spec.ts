import { expect, test } from '@playwright/test';
import { expectRouteLoads } from '../_support/assertions';

const publicRoutes = ['/', '/about', '/events', '/directors', '/sponsors', '/gallery', '/contact', '/policies'];

test.describe('public website', () => {
  for (const route of publicRoutes) {
    test(`${route} loads without a server error`, async ({ page }) => {
      await expectRouteLoads(page, route);
      await expect(page.locator('body')).toContainText(/ECCB|Emerald Coast|Community Band|Band/i);
    });
  }

  test('contact page exposes a usable contact surface', async ({ page }) => {
    await expectRouteLoads(page, '/contact');
    await expect(page.locator('body')).toContainText(/contact|email|message|phone/i);
  });
});
