import { defineConfig, devices } from '@playwright/test';

const playwrightBaseUrl = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';

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
    },
    
    // Desktop Chrome
    {
      name: 'chromium',
      use: { 
        ...devices['Desktop Chrome'],
      },
      testIgnore: [/admin\/.*\.spec\.ts/],
    },
    
    // Desktop Firefox
    {
      name: 'firefox',
      use: { 
        ...devices['Desktop Firefox'],
      },
      testIgnore: [/admin\/.*\.spec\.ts/],
    },
    
    // Desktop Safari
    {
      name: 'webkit',
      use: { 
        ...devices['Desktop Safari'],
      },
      testIgnore: [/admin\/.*\.spec\.ts/],
    },
    
    // Mobile Chrome
    {
      name: 'Mobile Chrome',
      use: { 
        ...devices['Pixel 5'],
      },
      testIgnore: [/admin\/.*\.spec\.ts/],
    },
    
    // Mobile Safari
    {
      name: 'Mobile Safari',
      use: { 
        ...devices['iPhone 12'],
      },
      testIgnore: [/admin\/.*\.spec\.ts/],
    },
    
    // Tablet
    {
      name: 'Tablet',
      use: { 
        ...devices['iPad (gen 7)'],
      },
      testIgnore: [/admin\/.*\.spec\.ts/],
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
  ],

  webServer: {
    command: 'pnpm run dev',
    url: playwrightBaseUrl,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
});
