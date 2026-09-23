import { prepareLocalDatabases, runNpm } from './harness.ts';

console.log('[harness] 빠른 검사, 전용 PostgreSQL 통합 테스트, 브라우저 종단 테스트를 순서대로 실행합니다.');
const testDatabaseUrl = prepareLocalDatabases();

runNpm('자금 카탈로그 검증', 'funding:validate');
runNpm('Prettier 포맷 검사', 'format:check');
runNpm('ESLint', 'lint');
runNpm('TypeScript', 'typecheck');
runNpm('전용 PostgreSQL 통합 테스트', 'test:db', { ...process.env, TEST_DATABASE_URL: testDatabaseUrl });
runNpm('Playwright 핵심 사용자 흐름', 'verify:e2e', { ...process.env, TEST_DATABASE_URL: testDatabaseUrl });

console.log('\n[harness] 전체 검증을 통과했습니다. Docker Desktop과 PostgreSQL은 실행 상태로 유지됩니다.');
