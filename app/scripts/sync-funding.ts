import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { todayInKst } from '../src/features/funding/dates.ts';
import { runFundingSync, type FundingSourceAdapter } from '../src/features/funding/sync.ts';
import { FundingCatalogError } from '../src/features/funding/validation.ts';

const DEFAULT_CATALOG = fileURLToPath(new URL('../catalog/funding/catalog.json', import.meta.url));
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL('../../data/funding-sync/', import.meta.url));

// funding:sync가 공고를 모으는 출처별 수집기. ADR 0006의 출처 확인(robots.txt·약관)을 거친 출처만 등록한다.
// 등록된 수집기가 없으면 사람이 관리하는 카탈로그만 새 릴리스로 적재한다.
const SOURCE_ADAPTERS: readonly FundingSourceAdapter[] = [];

const USAGE = `공식 출처에서 자금 공고를 모아 사람이 관리하는 카탈로그와 합치고 새 릴리스로 적재합니다(ADR 0006).

사용법:
  npm run funding:sync -- [옵션]

옵션:
  --catalog <경로>      사람이 관리하는 카탈로그 JSON (기본값: app/catalog/funding/catalog.json)
  --output-dir <경로>   합친 카탈로그를 쓸 폴더 (기본값: data/funding-sync/)
  --dry-run             합친 카탈로그를 쓰고 검증만 하며 적재하지 않습니다
  -h, --help            이 도움말

동작:
  - 웹 요청 중에는 실행하지 않습니다. 운영자나 정기 실행이 하루 한 번 실행합니다.
  - 출처가 실패하면(장애, 빈 응답, 직전 성공 대비 절반 미만, 검증 실패) 그 출처의 상품은 직전 ACTIVE 릴리스의 것을 그대로 두고 마지막 성공일도 그대로 둡니다.
  - 자동 상품은 출처의 마지막 성공 동기화가 3일을 넘기면 현재 후보에서 빠집니다.
  - 사람이 기록한 상품이 같은 공고를 가리키면 사람 기록이 우선합니다.
  - 내용이 같은 자동 상품은 이미 적재된 상품 버전을 재사용하고, 바뀌면 새 버전을 만듭니다.
  - 합친 카탈로그는 funding:load와 같은 검사를 거쳐 PENDING → ACTIVE로 적재합니다.`;

type CliOptions = { catalogPath: string; outputDir: string; dryRun: boolean; help: boolean };

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    catalogPath: DEFAULT_CATALOG,
    outputDir: DEFAULT_OUTPUT_DIR,
    dryRun: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--catalog' || argument === '--output-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error(`${argument} 뒤에 경로가 필요합니다.`);
      if (argument === '--catalog') options.catalogPath = resolve(value);
      else options.outputDir = resolve(value);
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
  if (SOURCE_ADAPTERS.length === 0) {
    console.log('등록된 출처 수집기가 없습니다. 사람이 관리하는 카탈로그만 합쳐 적재합니다.');
  }
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const report = await runFundingSync({
      prisma,
      catalogPath: options.catalogPath,
      adapters: SOURCE_ADAPTERS,
      asOfDate: todayInKst(),
      outputDir: options.outputDir,
      dryRun: options.dryRun,
      log: (message) => console.log(message),
    });
    console.log('');
    for (const source of report.sources) {
      const state = source.status === 'SUCCEEDED' ? '성공' : `실패(${source.failureReason ?? '사유 없음'})`;
      console.log(
        `출처 ${source.source}: ${state} · 상품 ${source.productCount}건${source.carriedOver ? '(직전 릴리스에서 유지)' : ''} · 마지막 성공일 ${source.lastSucceededOn ?? '없음'}`,
      );
    }
    console.log(`사람이 기록한 상품 ${report.manualProductCount}건 · 자동 상품 ${report.automatedProductCount}건`);
    if (report.overriddenByManual.length > 0) {
      console.log(`사람 기록이 우선해 뺀 자동 상품: ${report.overriddenByManual.join(', ')}`);
    }
    console.log(`합친 카탈로그: ${report.catalogFile}`);
    if (report.load === null) {
      console.log('dry run이라 적재하지 않았습니다.');
    } else {
      for (const warning of report.load.warnings) {
        console.warn(`주의 [${warning.code}] ${warning.source}: ${warning.detail}`);
      }
      console.log(`결과: ${report.load.outcome}`);
      console.log(`카탈로그: ${report.load.catalogKey}@${report.load.catalogVersion} (${report.load.releaseId})`);
      console.log(`checksum: ${report.load.catalogChecksum}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof FundingCatalogError) {
    console.error(`오류 [${error.code}] ${error.message}`);
    for (const issue of error.issues ?? []) console.error(`  - [${issue.code}] ${issue.source}: ${issue.detail}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
