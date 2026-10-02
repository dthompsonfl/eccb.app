import { defineConfig, devices } from '@playwright/test';

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
    {
      name: 'stand',
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
