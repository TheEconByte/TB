import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { todayInKst } from '../src/features/funding/dates.ts';
import { loadFundingCatalog } from '../src/features/funding/loader.ts';
import { FundingCatalogError } from '../src/features/funding/validation.ts';

const DEFAULT_CATALOG = fileURLToPath(new URL('../catalog/funding/catalog.json', import.meta.url));

const USAGE = `검수된 자금 공고 카탈로그를 새 릴리스로 적재합니다.

사용법:
  npm run funding:load -- [옵션]

옵션:
  --catalog <경로>    적재할 카탈로그 JSON (기본값: app/catalog/funding/catalog.json)
  -h, --help          이 도움말

동작:
  - 웹 요청 중에는 실행하지 않습니다. 운영자가 직접 실행합니다.
  - funding:validate와 같은 검사를 먼저 수행하고, 통과한 카탈로그만 적재합니다.
  - 카탈로그와 모든 상품에 실제 검수자가 지정되어야 하며 UNASSIGNED는 거부합니다.
  - 검증을 우회하는 옵션은 없습니다.
  - 상품 버전은 불변으로 저장하며, 같은 productKey + version을 재사용할 때 내용이 다르면 거부합니다.
  - 카탈로그 릴리스는 PENDING으로 적재한 뒤 전체 검증을 통과해야 한 트랜잭션으로 ACTIVE가 됩니다.
  - 같은 checksum의 카탈로그를 다시 적재하면 중복 행을 만들지 않고 ALREADY_ACTIVE로 끝납니다.
  - 실패하면 이번 적재가 만든 상품 버전만 정리하고 릴리스를 FAILED로 남기며, 기존 ACTIVE 카탈로그는 그대로 서비스됩니다.`;

type CliOptions = { catalogPath: string; help: boolean };

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { catalogPath: DEFAULT_CATALOG, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--catalog') {
      const value = argv[index + 1];
      if (!value) throw new Error('--catalog 뒤에 경로가 필요합니다.');
      options.catalogPath = resolve(value);
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
    const report = await loadFundingCatalog({
      catalogPath: options.catalogPath,
      prisma,
      asOfDate: todayInKst(),
      log: (message) => console.log(message),
    });
    for (const warning of report.warnings) {
      console.warn(`주의 [${warning.code}] ${warning.source}: ${warning.detail}`);
    }
    console.log('');
    console.log(`결과: ${report.outcome}`);
    console.log(`카탈로그: ${report.catalogKey}@${report.catalogVersion} (${report.releaseId})`);
    console.log(`checksum: ${report.catalogChecksum}`);
    console.log(`기준일: ${report.basisDate} · 검수일: ${report.reviewedAt ?? '없음'} · 상품 ${report.productCount}건`);
    for (const product of report.products) console.log(`  - ${product}`);
    console.log(`검수 기한 경과: ${report.reviewOverdue.length === 0 ? '없음' : report.reviewOverdue.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof FundingCatalogError) {
    console.error(`오류 [${error.code}] ${error.message}`);
    for (const issue of error.issues ?? []) console.error(`  - [${issue.code}] ${issue.source}: ${issue.detail}`);
    if (error.errorCounts) console.error(`  전체 오류 집계: ${JSON.stringify(error.errorCounts)}`);
  } else {
    console.error(error instanceof Error ? error.message : String(error));
  }
  process.exitCode = 1;
});
