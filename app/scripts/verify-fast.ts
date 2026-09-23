import { runNpm } from './harness.ts';

runNpm('자금 카탈로그 검증', 'funding:validate');
runNpm('Prettier 포맷 검사', 'format:check');
runNpm('ESLint', 'lint');
runNpm('TypeScript', 'typecheck');
runNpm('DB 비의존 테스트', 'test');

console.log('\n[harness] 빠른 검증을 통과했습니다.');
