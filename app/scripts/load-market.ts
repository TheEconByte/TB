import { resolve } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import {
  loadMarketRelease,
  loadMarketReleaseFromApi,
  MARKET_API_DEFAULT_START_QUARTER,
  type MarketLoadReport,
} from '../src/features/market/loader.ts';
import { isQuarter } from '../src/features/market/quarter.ts';
import { secretMasker } from '../src/features/market/seoul-api.ts';
import { MarketSourceError } from '../src/features/market/validation.ts';

const USAGE = `서울시 상권 데이터를 새 릴리스로 적재합니다.

사용법:
  npm run market:load -- [옵션]

옵션:
  --from <YYYYQ>            받을 첫 분기 (기본값: ${MARKET_API_DEFAULT_START_QUARTER})
  --to <YYYYQ>              받을 마지막 분기 (기본값: 매출·점포가 모두 있는 최신 분기)
  --source-dir <경로>       API 대신 2026-09-09에 검증한 ZIP 원본 폴더를 적재합니다
  -h, --help                이 도움말

동작:
  - 기본은 서울 열린데이터광장 Open API입니다. app/.env.local의 SEOUL_OPEN_API_KEY가 필요합니다.
  - 웹 요청 중에는 실행하지 않습니다. 운영자가 직접 실행합니다.
  - 분기마다 전체 건수만큼 받았는지, 코드·분기·키 누락·중복·음수 금액·점포 수 항등식을 검사합니다.
  - 원본을 모두 검증한 뒤 트랜잭션으로 활성화하고, 실패하면 기존 활성 릴리스를 유지합니다.`;

type CliOptions = { sourceDir: string | null; from: string | null; to: string | null; help: boolean };

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { sourceDir: null, from: null, to: null, help: false };
  const value = (index: number, name: string) => {
    const next = argv[index + 1];
    if (!next) throw new Error(`${name} 뒤에 값이 필요합니다.`);
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--source-dir') {
      options.sourceDir = resolve(value(index, argument));
      index += 1;
    } else if (argument === '--from' || argument === '--to') {
      const quarter = value(index, argument);
      if (!isQuarter(quarter)) throw new Error(`${argument}는 YYYYQ 형식이어야 합니다(예: 20241): ${quarter}`);
      if (argument === '--from') options.from = quarter;
      else options.to = quarter;
      index += 1;
    } else {
      throw new Error(`알 수 없는 옵션입니다: ${argument}`);
    }
  }
  if (options.sourceDir && (options.from || options.to)) {
    throw new Error('--source-dir은 기록된 파일의 기준기간을 쓰므로 --from·--to와 함께 쓸 수 없습니다.');
  }
  return options;
}

function printReport(report: MarketLoadReport) {
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
}

const apiKey = process.env.SEOUL_OPEN_API_KEY?.trim() ?? '';
const mask = apiKey ? secretMasker(apiKey) : (text: string) => text;

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
  if (!options.sourceDir && !apiKey) {
    throw new Error(
      'SEOUL_OPEN_API_KEY가 없습니다. app/.env.local에 서울 열린데이터광장 인증키를 넣거나, --source-dir로 검증한 ZIP 원본을 적재해 주세요.',
    );
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const log = (message: string) => console.log(mask(message));
  try {
    const report = options.sourceDir
      ? await loadMarketRelease({ sourceDir: options.sourceDir, prisma, log })
      : await loadMarketReleaseFromApi({
          apiKey,
          prisma,
          fromQuarter: options.from ?? undefined,
          toQuarter: options.to ?? undefined,
          log,
        });
    printReport(report);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof MarketSourceError) {
    console.error(mask(`오류 [${error.code}] ${error.message}`));
    for (const issue of error.issues ?? []) {
      console.error(
        mask(`  - [${issue.code}] ${issue.source}${issue.row === undefined ? '' : ` ${issue.row}행`}: ${issue.detail}`),
      );
    }
    if (error.errorCounts) console.error(`  전체 오류 집계: ${JSON.stringify(error.errorCounts)}`);
  } else {
    console.error(mask(error instanceof Error ? error.message : String(error)));
  }
  process.exitCode = 1;
});
