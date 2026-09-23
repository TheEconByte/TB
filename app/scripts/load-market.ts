import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { loadMarketRelease } from '../src/features/market/loader.ts';
import { MarketSourceError } from '../src/features/market/validation.ts';

const DEFAULT_SOURCE_DIR = fileURLToPath(new URL('../../data/raw/', import.meta.url));

const USAGE = `공공 상권 파일을 새 릴리스로 적재합니다.

사용법:
  npm run market:load -- [옵션]

옵션:
  --source-dir <경로>       원본 ZIP 폴더 (기본값: <저장소 루트>/data/raw)
  -h, --help                이 도움말

동작:
  - 웹 요청 중에는 실행하지 않습니다. 운영자가 직접 실행합니다.
  - 인코딩·헤더·코드·분기·키 누락·중복·음수 금액·checksum을 검사합니다.
  - 원본을 모두 검증한 뒤 트랜잭션으로 활성화하고, 실패하면 기존 활성 릴리스를 유지합니다.`;

type CliOptions = { sourceDir: string; help: boolean };

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { sourceDir: DEFAULT_SOURCE_DIR, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--source-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--source-dir 뒤에 경로가 필요합니다.');
      options.sourceDir = resolve(value);
      index += 1;
    } else {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    }
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL이 없습니다. app/.env.local을 준비하거나 DATABASE_URL을 지정해 주세요.');
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const report = await loadMarketRelease({
      sourceDir: options.sourceDir,
      prisma,
      log: (message) => console.log(message),
    });
    for (const warning of report.warnings) {
      console.warn(`경고 [${warning.code}] ${warning.source}: ${warning.detail}`);
    }
    console.log('');
    console.log(`결과: ${report.outcome}`);
    console.log(`릴리스: ${report.releaseKey} (${report.releaseId})`);
    console.log(`상권 ${report.areaCount}건 · 분기 지표 ${report.quarterlyRowCount}건`);
    console.log(
      `매출 행 ${report.salesRows}건 · 점포 행 ${report.storeRows}건 · 점포에만 있는 결합 키 ${report.storeOnlyKeys}건`,
    );
    for (const check of report.checks) {
      console.log(`  [${check.passed ? '통과' : '실패'}] ${check.name}: 예상 ${check.expected} / 실제 ${check.actual}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof MarketSourceError) {
    console.error(`오류 [${error.code}] ${error.message}`);
    for (const issue of error.issues ?? []) {
      console.error(
        `  - [${issue.code}] ${issue.source}${issue.row === undefined ? '' : ` ${issue.row}행`}: ${issue.detail}`,
      );
    }
    if (error.errorCounts) console.error(`  전체 오류 집계: ${JSON.stringify(error.errorCounts)}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
