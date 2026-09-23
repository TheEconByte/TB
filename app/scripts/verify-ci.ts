import { requireDedicatedTestDatabase, requirePrismaCli, runNpm, runStep } from './harness.ts';

const testDatabaseUrl = requireDedicatedTestDatabase();
runNpm('운영 DB migration 상태', 'db:status');
runStep('테스트 DB migration 상태', process.execPath, [requirePrismaCli(), 'migrate', 'status'], {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
});
runNpm('자금 카탈로그 검증', 'funding:validate');
runNpm('Prettier 포맷 검사', 'format:check');
runNpm('ESLint', 'lint');
runNpm('TypeScript', 'typecheck');
runNpm('전용 PostgreSQL 통합 테스트', 'test:db', { ...process.env, TEST_DATABASE_URL: testDatabaseUrl });

console.log('\n[harness] CI 코드·DB 검증을 통과했습니다.');
