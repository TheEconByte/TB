import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

// Mutation tests never reuse the application's DATABASE_URL. They run only
// when an explicit TEST_DATABASE_URL is supplied by the environment or the
// test-only env file.
function testDatabaseUrl(): string {
  if (process.env.TRENDBENCH_TEST_MODE === 'unit') return '';
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  if (!existsSync('.env.test.local')) return '';
  return (
    readFileSync('.env.test.local', 'utf8')
      .match(/^TEST_DATABASE_URL=(.*)$/m)?.[1]
      ?.trim() ?? ''
  );
}

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    env: { TEST_DATABASE_URL: testDatabaseUrl() },
    exclude: [...configDefaults.exclude, '**/e2e/**'],
    // PostgreSQL을 변경하는 테스트 파일들이 하나의 테스트 DB에서 ACTIVE 릴리스를
    // 서로 바꾸지 않도록 파일 단위로 순차 실행한다.
    fileParallelism: false,
  },
});
