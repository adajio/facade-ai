import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const results = process.env.FACADE_E2E_OUTPUT ?? 'test-results';
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export default defineConfig({
  testDir: './e2e',
  timeout: 100_000,
  expect: { timeout: 12_000 },
  workers: 1,
  outputDir: join(results, 'artifacts'),
  reporter: [['list'], ['json', { outputFile: join(results, 'browser.json') }]],
  use: {
    baseURL: process.env.FACADE_E2E_BASE_URL ?? 'http://127.0.0.1:18080',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
    launchOptions: {
      executablePath: process.env.FACADE_CHROME_PATH ?? (existsSync(chrome) ? chrome : undefined),
    },
  },
  projects: [{ name: 'stand', use: { browserName: 'chromium' } }],
});
