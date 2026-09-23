import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

export const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPOSITORY_DIR = resolve(APP_DIR, '..');
export const INFRA_ENV = resolve(REPOSITORY_DIR, 'infra', '.env');
export const COMPOSE_FILE = resolve(REPOSITORY_DIR, 'infra', 'compose.yaml');
export const PRISMA_CLI = resolve(APP_DIR, 'node_modules', 'prisma', 'build', 'index.js');

export function readEnvValue(path: string, key: string): string | undefined {
  if (!existsSync(path)) return undefined;

  const line = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .find((entry) => entry.trimStart().startsWith(`${key}=`));
  if (line === undefined) return undefined;

  const value = line.slice(line.indexOf('=') + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function fail(message: string): never {
  console.error(`\n[harness] ${message}`);
  process.exit(1);
}

export function npmCli(): string {
  const value = process.env.npm_execpath;
  if (!value || !existsSync(value))
    fail('npm 실행 경로를 찾을 수 없습니다. npm --prefix app run <명령>으로 실행하세요.');
  return value;
}

export function requirePrismaCli(): string {
  if (!existsSync(PRISMA_CLI)) fail('Prisma CLI가 없습니다. npm --prefix app ci로 의존성을 먼저 설치하세요.');
  return PRISMA_CLI;
}

export function runCaptured(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd: APP_DIR, encoding: 'utf8', env });
}

export function runStep(
  label: string,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  console.log(`\n[harness] ${label}`);
  const result = spawnSync(command, args, { cwd: APP_DIR, env, stdio: 'inherit' });
  if (result.error !== undefined) fail(`${label} 실행 실패: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} 실패 (종료 코드 ${result.status ?? 'unknown'})`);
}

export function runNpm(label: string, script: string, env: NodeJS.ProcessEnv = process.env): void {
  runStep(label, process.execPath, [npmCli(), 'run', script], env);
}

export function applicationDatabaseUrl(): string | undefined {
  return process.env.DATABASE_URL ?? readEnvValue(resolve(APP_DIR, '.env.local'), 'DATABASE_URL');
}

export function requireDedicatedTestDatabase(): string {
  const testDatabaseUrl =
    process.env.TEST_DATABASE_URL ?? readEnvValue(resolve(APP_DIR, '.env.test.local'), 'TEST_DATABASE_URL');
  if (!testDatabaseUrl) {
    fail('TEST_DATABASE_URL이 없습니다. bootstrap을 실행하거나 app/.env.test.local에 전용 테스트 DB를 설정하세요.');
  }

  const applicationUrl = applicationDatabaseUrl();
  if (applicationUrl && applicationUrl === testDatabaseUrl) {
    fail('TEST_DATABASE_URL은 DATABASE_URL과 다른 전용 테스트 DB여야 합니다.');
  }
  return testDatabaseUrl;
}

export function composeArgs(): string[] {
  if (!existsSync(INFRA_ENV)) fail('infra/.env가 없습니다. npm --prefix app run bootstrap을 먼저 실행하세요.');
  return ['compose', '--env-file', INFRA_ENV, '-f', COMPOSE_FILE];
}

export function printDockerRecovery(): void {
  console.error(`
[harness] Docker 엔진에 연결할 수 없습니다. 하네스는 Docker Desktop을 종료하거나 재시작하지 않습니다.

1. Docker Desktop을 한 번 실행한 뒤 명령을 다시 실행하세요.
2. sailor-ingest.sock 또는 engine.sock의 rename 오류가 보이면 docs/DEVELOPMENT.md의
   "Docker Desktop 소켓 오류" 절차를 따르세요.
3. docker compose down -v 또는 prisma migrate reset은 실행하지 마세요. 로컬 DB 데이터가 삭제될 수 있습니다.
`);
}

export function prepareLocalDatabases(): string {
  const dockerInfo = runCaptured('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (dockerInfo.error !== undefined || dockerInfo.status !== 0) {
    if (dockerInfo.stderr) process.stderr.write(dockerInfo.stderr);
    printDockerRecovery();
    process.exit(1);
  }
  console.log(`[harness] Docker Engine ${dockerInfo.stdout.trim()} 사용 가능`);

  const testDatabaseUrl = requireDedicatedTestDatabase();
  const args = composeArgs();
  runStep('Compose 구성 검사', 'docker', [...args, 'config', '--quiet']);
  runStep('PostgreSQL 기동 및 healthcheck 대기', 'docker', [...args, 'up', '-d', '--wait']);
  runNpm('운영 DB migration 상태', 'db:status');
  runStep('테스트 DB migration 상태', process.execPath, [requirePrismaCli(), 'migrate', 'status'], {
    ...process.env,
    DATABASE_URL: testDatabaseUrl,
  });
  return testDatabaseUrl;
}
