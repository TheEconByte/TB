import { resolve } from 'node:path';
import { APP_DIR, fail, requireDedicatedTestDatabase, runStep } from './harness.ts';

const mode = process.argv[2];
if (mode !== 'unit' && mode !== 'database') fail('테스트 모드는 unit 또는 database여야 합니다.');

const vitestCli = resolve(APP_DIR, 'node_modules', 'vitest', 'vitest.mjs');
const env = { ...process.env };

if (mode === 'unit') {
  delete env.TEST_DATABASE_URL;
  env.TRENDBENCH_TEST_MODE = 'unit';
} else {
  env.TEST_DATABASE_URL = requireDedicatedTestDatabase();
  env.TRENDBENCH_TEST_MODE = 'database';
}

runStep(
  mode === 'unit' ? 'Vitest 빠른 테스트' : 'Vitest PostgreSQL 통합 테스트 포함',
  process.execPath,
  [vitestCli, 'run'],
  env,
);
