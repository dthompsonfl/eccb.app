import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const ADMIN_STORAGE_STATE = 'e2e/.auth/admin.json';

setup('authenticate seeded administrator', async ({ page }) => {
  const email = process.env.E2E_ADMIN_EMAIL || process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD;

  setup.skip(!email || !password, 'Set E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD or SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD to run authenticated E2E tests.');

  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toBeVisible();

  await page.getByLabel(/email/i).fill(email!);
  await page.getByLabel(/password/i).fill(password!);
  await page.getByRole('button', { name: /sign in|log in|login/i }).click();

  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 30000 });
  mkdirSync('e2e/.auth', { recursive: true });
  await page.context().storageState({ path: ADMIN_STORAGE_STATE });
});
