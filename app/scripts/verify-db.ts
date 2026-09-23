import { prepareLocalDatabases, runNpm } from './harness.ts';

const testDatabaseUrl = prepareLocalDatabases();
runNpm('전용 PostgreSQL 통합 테스트', 'test:db', { ...process.env, TEST_DATABASE_URL: testDatabaseUrl });

console.log('\n[harness] 로컬 DB 검증을 통과했습니다. Docker Desktop과 PostgreSQL은 실행 상태로 유지됩니다.');
