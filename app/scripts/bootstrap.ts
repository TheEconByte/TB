import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  APP_DIR,
  INFRA_ENV,
  applicationDatabaseUrl,
  composeArgs,
  fail,
  printDockerRecovery,
  requireDedicatedTestDatabase,
  requirePrismaCli,
  runCaptured,
  runNpm,
  runStep,
} from './harness.ts';

const appEnv = resolve(APP_DIR, '.env.local');
const testEnv = resolve(APP_DIR, '.env.test.local');
const envFiles = [INFRA_ENV, appEnv, testEnv];
const existingCount = envFiles.filter(existsSync).length;

if (existingCount === 0) {
  const password = randomBytes(24).toString('base64url');
  const authSecret = randomBytes(48).toString('base64url');
  const encodedPassword = encodeURIComponent(password);
  writeFileSync(INFRA_ENV, `POSTGRES_PASSWORD=${password}\nPOSTGRES_PORT=5433\n`, { flag: 'wx' });
  writeFileSync(
    appEnv,
    `DATABASE_URL=postgresql://trendbench:${encodedPassword}@127.0.0.1:5433/trendbench_mvp\nBETTER_AUTH_SECRET=${authSecret}\nBETTER_AUTH_URL=http://localhost:3000\n`,
    { flag: 'wx' },
  );
  writeFileSync(
    testEnv,
    `TEST_DATABASE_URL=postgresql://trendbench:${encodedPassword}@127.0.0.1:5433/trendbench_mvp_test\n`,
    { flag: 'wx' },
  );
  console.log(
    '[bootstrap] Git에서 제외되는 로컬 환경파일 3개를 새 값으로 생성했습니다. 기존 파일은 덮어쓰지 않습니다.',
  );
} else if (existingCount !== envFiles.length) {
  const missing = envFiles.filter((path) => !existsSync(path));
  fail(`환경파일 일부만 존재해 자동으로 값을 추측하지 않습니다. 누락 파일: ${missing.join(', ')}`);
}

const applicationUrl = applicationDatabaseUrl();
if (!applicationUrl) fail('app/.env.local에 DATABASE_URL이 없습니다.');
const testDatabaseUrl = requireDedicatedTestDatabase();
const testUrl = new URL(testDatabaseUrl);
const testDatabaseName = decodeURIComponent(testUrl.pathname.slice(1));
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(testDatabaseName)) fail('테스트 DB 이름은 영문자·숫자·밑줄만 사용할 수 있습니다.');

const dockerInfo = runCaptured('docker', ['info', '--format', '{{.ServerVersion}}']);
if (dockerInfo.error !== undefined || dockerInfo.status !== 0) {
  if (dockerInfo.stderr) process.stderr.write(dockerInfo.stderr);
  printDockerRecovery();
  process.exit(1);
}

const args = composeArgs();
runStep('Compose 구성 검사', 'docker', [...args, 'config', '--quiet']);
runStep('PostgreSQL 기동 및 healthcheck 대기', 'docker', [...args, 'up', '-d', '--wait']);

const databaseExists = runCaptured('docker', [
  ...args,
  'exec',
  '-T',
  'postgres',
  'psql',
  '-U',
  'trendbench',
  '-d',
  'postgres',
  '-tAc',
  `SELECT 1 FROM pg_database WHERE datname = '${testDatabaseName}'`,
]);
if (databaseExists.error !== undefined || databaseExists.status !== 0) {
  if (databaseExists.stderr) process.stderr.write(databaseExists.stderr);
  fail('테스트 DB 존재 여부를 확인하지 못했습니다.');
}
if (databaseExists.stdout.trim() !== '1') {
  runStep('전용 테스트 DB 생성', 'docker', [
    ...args,
    'exec',
    '-T',
    'postgres',
    'createdb',
    '-U',
    'trendbench',
    testDatabaseName,
  ]);
} else {
  console.log(`[bootstrap] 전용 테스트 DB ${testDatabaseName} 재사용`);
}

runNpm('Prisma Client 생성', 'db:generate');
runNpm('운영 DB migration 적용', 'db:deploy');
runStep('테스트 DB migration 적용', process.execPath, [requirePrismaCli(), 'migrate', 'deploy'], {
  ...process.env,
  DATABASE_URL: testDatabaseUrl,
});

if (!process.argv.includes('--skip-browser')) {
  const playwrightCli = resolve(APP_DIR, 'node_modules', 'playwright', 'cli.js');
  if (!existsSync(playwrightCli)) fail('Playwright CLI가 없습니다. npm --prefix app ci를 먼저 실행하세요.');
  runStep('Playwright Chromium 준비', process.execPath, [playwrightCli, 'install', 'chromium']);
}

console.log('\n[bootstrap] 환경 준비가 끝났습니다. npm --prefix app run verify를 실행하세요.');
