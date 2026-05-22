import { expect, type Page } from '@playwright/test';

export async function expectHealthyPage(page: Page): Promise<void> {
  await expect(page.locator('body')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/application error|internal server error|unhandled runtime error|stack trace/i);
}

export async function expectRouteLoads(page: Page, path: string): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response, `${path} should return a response`).not.toBeNull();
  expect(response!.status(), `${path} should not return a server error`).toBeLessThan(500);
  await expectHealthyPage(page);
}
