import { expect, test } from '@playwright/test';
import { expectRouteLoads } from '../_support/assertions';

test.describe('digital music stand access boundary', () => {
  test('stand route does not expose a public server error', async ({ page }) => {
    await expectRouteLoads(page, '/member/stand');
    await expect(page.locator('body')).toContainText(/stand|music|login|sign in|forbidden|dashboard/i);
  });
});
