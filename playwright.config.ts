import { defineConfig, devices } from '@playwright/test';
import { config as loadDotenv } from 'dotenv';

// Load `.env` BEFORE any config reads process.env.
//
// Without this the authenticated suites silently degrade. `e2e/auth.setup.ts`
// reads `E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD` and falls back to
// `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`; Playwright does not load `.env` on
// its own, so with a populated `.env` and no exported variables both were
// undefined and the setup step took its `setup.skip(...)` path.
//
// The visible symptom is NOT a skip. `a11y-member` then ran unauthenticated,
// every `/member` route redirected to `/login`, and the specs failed with
// "...redirected to a login/unauthenticated page" — which reads exactly like a
// broken login flow or a real accessibility defect. It is neither.
//
// `override` is false, so an explicitly exported variable still wins, and real
// environment variables are not clobbered by file values.
loadDotenv({ override: false, quiet: true });

const appPort = process.env.PORT || '3225';
const playwrightBaseUrl = process.env.PLAYWRIGHT_BASE_URL || `http://localhost:${appPort}`;

/**
 * Optional browser-binary override.
 *
 * Playwright pins an exact Chromium build per platform. On hosts it does not
 * publish a build for (e.g. Ubuntu 26.04, where `playwright install` fails with
 * "Playwright does not support chromium on ubuntu26.04-x64"), `npx playwright
 * test` cannot launch at all. Setting PLAYWRIGHT_CHROME_EXE to any compatible
 * Chrome/Chromium binary lets the suites run there.
 *
 * This changes ONLY which browser binary starts. It cannot mask, skip or soften
 * any assertion — axe-core runs and reports exactly as before.
 */
const chromeExe = process.env.PLAYWRIGHT_CHROME_EXE;
const chromeLaunch = chromeExe ? { launchOptions: { executablePath: chromeExe } } : {};

/**
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
    ['json', { outputFile: 'e2e-results.json' }],
  ],
  use: {
    baseURL: playwrightBaseUrl,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },

  projects: [
    // Authentication setup
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
      use: { ...chromeLaunch },
    },
    
    // Desktop Chrome
    //
    // The stand suite runs in its own `stand` project (see below) because it
    // needs the authenticated storage state; `stand` is excluded here so the
    // stand specs do not also run unauthenticated.
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
      },
      testIgnore: [
        /admin\/.*\.spec\.ts/,
        /accessibility\/.*\.spec\.ts/,
        /stand\/.*\.spec\.ts/,
      ],
    },
    
    // Desktop Firefox
    {
      name: 'firefox',
      use: { 
        ...devices['Desktop Firefox'],
      },
      testIgnore: [
        /admin\/.*\.spec\.ts/,
        /accessibility\/.*\.spec\.ts/,
        /stand\/.*\.spec\.ts/,
      ],
    },
    
    // Desktop Safari
    {
      name: 'webkit',
      use: { 
        ...devices['Desktop Safari'],
      },
      testIgnore: [
        /admin\/.*\.spec\.ts/,
        /accessibility\/.*\.spec\.ts/,
        /stand\/.*\.spec\.ts/,
      ],
    },
    
    // Mobile Chrome
    {
      name: 'Mobile Chrome',
      use: { 
        ...devices['Pixel 5'],
      },
      testIgnore: [
        /admin\/.*\.spec\.ts/,
        /accessibility\/.*\.spec\.ts/,
        /stand\/.*\.spec\.ts/,
      ],
    },
    
    // Mobile Safari
    {
      name: 'Mobile Safari',
      use: { 
        ...devices['iPhone 12'],
      },
      testIgnore: [
        /admin\/.*\.spec\.ts/,
        /accessibility\/.*\.spec\.ts/,
        /stand\/.*\.spec\.ts/,
      ],
    },
    
    // Tablet
    {
      name: 'Tablet',
      use: { 
        ...devices['iPad (gen 7)'],
      },
      testIgnore: [
        /admin\/.*\.spec\.ts/,
        /accessibility\/.*\.spec\.ts/,
        /stand\/.*\.spec\.ts/,
      ],
    },
    
    // Admin tests
    {
      name: 'admin',
      use: {
        ...devices['Desktop Chrome'],
        ...chromeLaunch,
        storageState: 'e2e/.auth/admin.json',
      },
      testMatch: /admin\/.*\.spec\.ts/,
      dependencies: ['setup'],
    },

    // WCAG 2.1 AA automated scans — unauthenticated public surfaces.
    // Desktop Chrome only: axe-core rule output is engine-independent and one
    // deterministic engine keeps contrast/computed-style findings reproducible.
    {
      name: 'a11y-public',
      use: {
        ...devices['Desktop Chrome'],
        ...chromeLaunch,
      },
      testMatch: /accessibility\/public-.*\.spec\.ts/,
    },

    // WCAG 2.1 AA automated scans — authenticated surfaces.
    // Reuses the storage state produced by e2e/auth.setup.ts (the `setup`
    // project) rather than duplicating a login flow.
    {
      name: 'a11y-member',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/admin.json',
        ...chromeLaunch,
      },
      testMatch: /accessibility\/member-.*\.spec\.ts/,
      dependencies: ['setup'],
    },

    // Digital Music Stand workflow suite.
    //
    // These specs exercise the member's real workflow — open a score, confirm
    // the PDF actually rendered, draw an annotation and prove it survives a
    // full page reload, zoom, and page-layout — so they need the authenticated
    // member session produced by e2e/auth.setup.ts. Reusing that storage state
    // rather than logging in again keeps one login flow for the whole suite.
    //
    // `workers: 1` is load-bearing, not a concession to slow tests. Each spec
    // drives PDF.js to rasterise a real page in the browser AND waits on the
    // server rendering that score, so they contend for the same CPU. Run in
    // parallel (the config default is CPU/2 — 14 workers on a 28-core box) they
    // starve each other: `waitForPdfRendered` timed out on 14 of 21 specs even
    // though the render itself is fine. Verified by direct probe — the same page
    // renders a 612x792 canvas with 484,704 painted pixels. With `workers: 1`
    // the whole project passes 21/21 in ~24s.
    {
      name: 'stand',
      workers: 1,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/admin.json',
        ...chromeLaunch,
      },
      testMatch: /stand\/.*\.spec\.ts/,
      dependencies: ['setup'],
    },
  ],

  webServer: {
    command: 'npm run dev',
    url: playwrightBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});

/**
 * NOTE on `webServer` above.
 *
 * The command is `npm run dev`, which binds `PORT` (default 3000 in Next's own
 * default, 3225 via `.env` here). When `PLAYWRIGHT_BASE_URL` points at a DIFFERENT
 * port — the normal case when a server is already running, e.g. `npm run
 * start:all` on 3225 — Playwright starts this dev server, waits on
 * `playwrightBaseUrl`, and times out after 120s with a misleading
 * "Timed out waiting 120000ms from config.webServer" that reads like a hung app
 * rather than a port mismatch.
 *
 * Two separate failures were observed from this and both looked like product
 * bugs:
 *   - port 3000 already occupied by an unrelated app -> dev server rolls to 3001
 *   - the suite then waited on 3225, which nothing it started was serving
 *
 * `reuseExistingServer` already handles the common case correctly (an existing
 * server on the target URL is reused and no dev server is started). This comment
 * records the constraint so the failure is not misdiagnosed next time: if this
 * times out, check that `PLAYWRIGHT_BASE_URL` matches the port `npm run dev`
 * actually binds.
 */
