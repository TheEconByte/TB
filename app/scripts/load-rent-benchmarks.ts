import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { secretMasker } from '../src/features/market/seoul-api.ts';
import { loadRentBenchmarks, RentBenchmarkError } from '../src/features/rent-benchmark/loader.ts';

const USAGE = `한국부동산원 상업용부동산 임대동향조사의 서울 상가 임대료·층별 임대료·공실률을 적재합니다.

환경변수:
  DATABASE_URL  PostgreSQL 연결 문자열
  REB_API_KEY   부동산통계정보시스템(R-ONE) Open API 인증키

사용법:
  npm --prefix app run rent:load`;

const mask = secretMasker(process.env.REB_API_KEY ?? '');

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 없습니다.');
  if (!process.env.REB_API_KEY)
    throw new RentBenchmarkError('SOURCE_API_ERROR', 'REB_API_KEY가 없습니다. 키 값은 Git에 추가하지 마세요.');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const report = await loadRentBenchmarks({
      prisma,
      apiKey: process.env.REB_API_KEY,
      log: (message) => console.log(mask(message)),
    });
    console.log(`결과: ${report.outcome}`);
    console.log(`릴리스: ${report.releaseKey}`);
    console.log(`기준기간: ${report.basisPeriodLabel}`);
    console.log(`관측값: ${report.observationCount}건`);
    for (const check of report.checks) console.log(`검사 통과 · ${check.name}: ${check.detail}`);
    if (report.unmappedRegions.length > 0)
      console.log(`자치구와 연결하지 않은 조사 상권: ${report.unmappedRegions.join(', ')}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof RentBenchmarkError) console.error(mask(`오류 [${error.code}] ${error.message}`));
  else console.error(mask(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
