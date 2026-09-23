import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { defineConfig, devices } from '@playwright/test';

for (const file of ['.env.local', '.env.test.local']) {
  if (existsSync(file)) loadEnvFile(file);
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl)
  throw new Error('Playwright는 TEST_DATABASE_URL 전용 DB만 사용합니다. bootstrap을 먼저 실행하세요.');
if (process.env.DATABASE_URL === testDatabaseUrl)
  throw new Error('Playwright TEST_DATABASE_URL은 DATABASE_URL과 달라야 합니다.');

const baseURL = 'http://127.0.0.1:3100';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run build && npm run start -- --hostname 127.0.0.1 --port 3100',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 180_000,
    env: {
      DATABASE_URL: testDatabaseUrl,
      BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET ?? 'test-only-secret-at-least-32-characters',
      BETTER_AUTH_URL: baseURL,
      TRENDBENCH_E2E: '1',
    },
  },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
});
