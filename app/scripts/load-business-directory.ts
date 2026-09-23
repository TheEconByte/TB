import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { BusinessDirectoryError, loadBusinessDirectory } from '../src/features/business-directory/loader.ts';

const USAGE = `소진공 상가(상권)정보 API를 서울 음식점 스냅샷으로 적재합니다.

환경변수:
  DATABASE_URL       PostgreSQL 연결 문자열
  SEMAS_SERVICE_KEY  공공데이터포털에서 발급받은 일반 인증키(Decoding)

사용법:
  npm --prefix app run business:load`;

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL이 없습니다.');
  if (!process.env.SEMAS_SERVICE_KEY)
    throw new BusinessDirectoryError(
      'SERVICE_KEY_MISSING',
      'SEMAS_SERVICE_KEY가 없습니다. 키 값은 Git에 추가하지 마세요.',
    );
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  try {
    const result = await loadBusinessDirectory({ prisma, serviceKey: process.env.SEMAS_SERVICE_KEY, log: console.log });
    console.log(`결과: ${result.outcome}`);
    console.log(`릴리스: ${result.releaseKey}`);
    console.log(`지원 업종 점포: ${result.businessCount}건`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  if (error instanceof BusinessDirectoryError) console.error(`오류 [${error.code}] ${error.message}`);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
