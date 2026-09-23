import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { FranchiseError, loadFranchises } from '../src/features/franchise/loader.ts';
import { secretMasker } from '../src/features/market/seoul-api.ts';

const USAGE = `공정거래위원회 가맹정보(공공데이터포털)의 한식·커피·음료 브랜드 현황과 창업 금액을 적재합니다.

환경변수:
  DATABASE_URL       PostgreSQL 연결 문자열
  SEMAS_SERVICE_KEY  공공데이터포털 일반 인증키(Decoding). 소진공 적재와 같은 키이며,
                     '브랜드별 가맹점 현황'과 '브랜드별 창업 금액 현황' 활용신청이 필요합니다.

사용법:
  npm --prefix app run franchise:load
  npm --prefix app run franchise:load -- --latest-year 2025
  npm --prefix app run franchise:load -- --without-startup-costs   창업 금액 활용신청 전에만 사용`;

const mask = secretMasker(process.env.SEMAS_SERVICE_KEY ?? '');

function option(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? '');
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  const latestYearText = option('--latest-year');
  const latestYear = latestYearText === null ? undefined : Number(latestYearText);
  if (latestYear !== undefined && (!Number.isInteger(latestYear) || latestYear < 2015))
    throw new FranchiseError('INVALID_OPTION', '--latest-year는 2015 이상의 연도여야 합니다.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 없습니다.');
  if (!process.env.SEMAS_SERVICE_KEY)
    throw new FranchiseError('SOURCE_API_ERROR', 'SEMAS_SERVICE_KEY가 없습니다. 키 값은 Git에 추가하지 마세요.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const report = await loadFranchises({
      prisma,
      serviceKey: process.env.SEMAS_SERVICE_KEY,
      latestYear,
      includeStartupCosts: !process.argv.includes('--without-startup-costs'),
      log: (message) => console.log(mask(message)),
    });
    console.log(`결과: ${report.outcome}`);
    console.log(`릴리스: ${report.releaseKey}`);
    console.log(`정보공개서 기준년도: ${report.years.join(', ')}`);
    console.log(`브랜드 행: ${report.brandCount}건`);
    console.log(`창업 금액: ${report.startupCostsIncluded ? '포함' : '제외'}`);
    for (const check of report.checks) console.log(`검사 통과 · ${check.name}: ${check.detail}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof FranchiseError) console.error(mask(`오류 [${error.code}] ${error.message}`));
  else console.error(mask(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
