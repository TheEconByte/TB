import { runDiffCheck, runNpm } from './harness.ts';

// CI check job은 이 명령을 그대로 실행한다. 검사를 더하거나 빼면 CI도 함께 바뀐다.
runDiffCheck();
runNpm('자금 카탈로그 검증', 'funding:validate');
runNpm('Prettier 포맷 검사', 'format:check');
runNpm('ESLint', 'lint');
runNpm('TypeScript', 'typecheck');
runNpm('DB 비의존 테스트', 'test');
runNpm('production build', 'build');

console.log('\n[harness] 빠른 검증을 통과했습니다. CI check와 같은 검사입니다.');
