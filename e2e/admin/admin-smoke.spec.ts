import { expect, test } from '@playwright/test';
import { expectRouteLoads } from '../_support/assertions';

const adminRoutes = [
  '/admin',
  '/admin/members',
  '/admin/events',
  '/admin/music',
  '/admin/attendance',
  '/admin/pages',
  '/admin/assets',
  '/admin/sponsors',
  '/admin/gallery',
  '/admin/leadership',
  '/admin/contact-submissions',
  '/admin/settings',
];

test.describe('admin workspace', () => {
  for (const route of adminRoutes) {
    test(`${route} loads for authenticated admin`, async ({ page }) => {
      await expectRouteLoads(page, route);
      await expect(page).not.toHaveURL(/\/login/);
      await expect(page.locator('body')).not.toContainText(/forbidden|unauthorized/i);
    });
  }

  test('member creation surface is reachable', async ({ page }) => {
    await expectRouteLoads(page, '/admin/members/new');
    await expect(page.locator('body')).toContainText(/member|first name|last name|email/i);
  });

  test('event creation surface is reachable', async ({ page }) => {
    await expectRouteLoads(page, '/admin/events/new');
    await expect(page.locator('body')).toContainText(/event|title|date/i);
  });
});
