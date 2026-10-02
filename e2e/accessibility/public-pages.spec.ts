/**
 * Public-surface WCAG 2.1 AA scans (unauthenticated).
 *
 * Run via the `accessibility` Playwright project. Fails on serious/critical.
 */
import { expect, test } from '@playwright/test';
import { gotoSurface, scanSurface } from './_helpers';

test.describe('public accessibility — homepage', () => {
  test('public homepage has no serious or critical WCAG 2.1 AA violations', async ({
    page,
  }, testInfo) => {
    await gotoSurface(page, '/');
    await expect(page.locator('html')).toHaveAttribute('lang', /.+/);
    await scanSurface(page, testInfo, 'public homepage');
  });

  test('public homepage also has no serious or critical best-practice violations', async ({
    page,
  }, testInfo) => {
    await gotoSurface(page, '/');
    await scanSurface(page, testInfo, 'public homepage (best-practice)', {
      includeBestPractice: true,
    });
  });
});

test.describe('public accessibility — login page', () => {
  test('login page has no serious or critical WCAG 2.1 AA violations', async ({
    page,
  }, testInfo) => {
    await gotoSurface(page, '/login');
    await expect(page.locator('html')).toHaveAttribute('lang', /.+/);
    await scanSurface(page, testInfo, 'login page');
  });
});