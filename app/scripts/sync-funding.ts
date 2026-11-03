import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.ts';
import { secretMasker } from '../src/features/market/seoul-api.ts';
import { todayInKst } from '../src/features/funding/dates.ts';
import { createClaudeConditionExtractor } from '../src/features/funding/notice-extraction.ts';
import { createBizinfoAdapter } from '../src/features/funding/sources/bizinfo.ts';
import { createSemasOlsAdapter } from '../src/features/funding/sources/semas-ols.ts';
import { runFundingSync, type FundingSourceAdapter } from '../src/features/funding/sync.ts';
import { FundingCatalogError } from '../src/features/funding/validation.ts';

const DEFAULT_CATALOG = fileURLToPath(new URL('../catalog/funding/catalog.json', import.meta.url));
const DEFAULT_OUTPUT_DIR = fileURLToPath(new URL('../../data/funding-sync/', import.meta.url));

// funding:sync가 공고를 모으는 출처별 수집기. ADR 0006의 출처 확인(robots.txt·약관)을 거친 출처만 등록한다.
// 키·연락처가 없어도 등록한다. 그러면 그 출처는 실패로 기록되고, 직전 릴리스의 상품이 그대로 남는다.
const SOURCE_ADAPTERS: readonly FundingSourceAdapter[] = [
  createSemasOlsAdapter({ contact: process.env.FUNDING_SYNC_CONTACT }),
  createBizinfoAdapter({
    apiKey: process.env.BIZINFO_API_KEY,
    files: { contact: process.env.FUNDING_SYNC_CONTACT },
  }),
];

// 출력에 인증키가 남지 않게 가린다.
const maskBizinfo = secretMasker(process.env.BIZINFO_API_KEY ?? '');
const maskAnthropic = secretMasker(process.env.ANTHROPIC_API_KEY?.trim() ?? '');
const mask = (text: string) => maskAnthropic(maskBizinfo(text));
// 새 공고 이름은 이 수까지만 출력한다.
const MAX_LISTED_NEW_PRODUCTS = 30;

const USAGE = `공식 출처에서 자금 공고를 모아 사람이 관리하는 카탈로그와 합치고 새 릴리스로 적재합니다(ADR 0006).

사용법:
  npm run funding:sync -- [옵션]

환경변수:
  DATABASE_URL       PostgreSQL 연결 문자열
  BIZINFO_API_KEY    기업마당 지원사업정보 API 인증키. 없으면 기업마당 출처는 실패로 기록됩니다
  ANTHROPIC_API_KEY  공고 본문에서 조건을 읽는 Claude API 키(ADR 0009). 없으면 조건을 읽지 않고, 읽지 못한
                     공고는 다음 동기화에서 다시 읽습니다. 출처 동기화 결과는 같습니다
  FUNDING_SYNC_CONTACT
                     소진공 정책자금 사이트와 기업마당 공고 파일 요청의 User-Agent에 밝힐 운영자 연락처
                     (메일 주소나 웹 주소, ASCII). 없으면 소진공 출처는 실패로 기록되고, 파일이 있는 기업마당 공고는
                     본문을 새로 읽지 않습니다(직전 본문을 계속 씁니다)

옵션:
  --catalog <경로>      사람이 관리하는 카탈로그 JSON (기본값: app/catalog/funding/catalog.json)
  --output-dir <경로>   합친 카탈로그를 쓸 폴더 (기본값: data/funding-sync/)
  --dry-run             합친 카탈로그를 쓰고 검증만 하며 적재하지 않습니다
  -h, --help            이 도움말

동작:
  - 웹 요청 중에는 실행하지 않습니다. 운영자나 정기 실행이 하루 한 번 실행합니다.
  - 소진공 정책자금 사이트는 요청 사이 1초 이상 쉬며 읽고, 403·429·자동 입력 방지 화면이나 robots.txt 변경을 만나면 그 출처를 멈춥니다.
  - 출처가 실패하면(장애, 빈 응답, 직전 성공 대비 절반 미만, 검증 실패) 그 출처의 상품은 직전 ACTIVE 릴리스의 것을 그대로 두고 마지막 성공일도 그대로 둡니다.
  - 자동 상품은 출처의 마지막 성공 동기화가 3일을 넘기면 현재 후보에서 빠집니다.
  - 사람이 기록한 상품이 같은 공고를 가리키면 사람 기록이 우선합니다.
  - 공고 본문(기업마당 사업개요·본문출력파일·첨부의 PDF·HWP·HWPX, 소진공 공지 본문·정책자금 표)을 텍스트로 모아
    DB에 남깁니다(ADR 0009). 직전 본문과 문서 목록이 같으면 파일을 다시 받지 않습니다. 기업마당 파일은
    robots.txt를 확인한 뒤 1초 이상 쉬며 받고, 403·429를 만나면 그 동기화에서는 더 받지 않습니다.
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
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? '';
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  try {
    const report = await runFundingSync({
      prisma,
      catalogPath: options.catalogPath,
      adapters: SOURCE_ADAPTERS,
      asOfDate: todayInKst(),
      outputDir: options.outputDir,
      dryRun: options.dryRun,
      // 키가 있을 때만 만든다. 다른 경로(로그인 프로필 등)의 자격 증명은 쓰지 않는다.
      conditionExtractor:
        anthropicKey === '' ? null : createClaudeConditionExtractor(new Anthropic({ apiKey: anthropicKey })),
      log: (message) => console.log(mask(message)),
    });
    console.log('');
    for (const source of report.sources) {
      const state = source.status === 'SUCCEEDED' ? '성공' : `실패(${source.failureReason ?? '사유 없음'})`;
      console.log(
        mask(
          `출처 ${source.source}: ${state} · 상품 ${source.productCount}건${source.carriedOver ? '(직전 릴리스에서 유지)' : ''} · 마지막 성공일 ${source.lastSucceededOn ?? '없음'}`,
        ),
      );
      if (source.status === 'SUCCEEDED') {
        const texts = source.noticeTexts;
        console.log(
          `  공고 본문: 그대로 ${texts.REUSED}건 · 새로 읽음 ${texts.STORED}건 · 읽을 문서 없음 ${texts.NO_TEXT}건 · 파일을 다 받지 못함 ${texts.INCOMPLETE}건`,
        );
      }
      if (source.addedProducts.length > 0) {
        console.log(`  직전 릴리스에 없던 공고 ${source.addedProducts.length}건:`);
        for (const product of source.addedProducts.slice(0, MAX_LISTED_NEW_PRODUCTS)) {
          console.log(`  - ${product.name} (${product.productKey})`);
        }
        if (source.addedProducts.length > MAX_LISTED_NEW_PRODUCTS) {
          console.log(
            `  - 외 ${source.addedProducts.length - MAX_LISTED_NEW_PRODUCTS}건은 ${report.catalogFile}에서 확인하세요.`,
          );
        }
      }
    }
    console.log(`사람이 기록한 상품 ${report.manualProductCount}건 · 자동 상품 ${report.automatedProductCount}건`);
    if (report.conditions !== null) {
      const counts = report.conditions.counts;
      console.log(
        `공고 조건 추출: 이미 읽음 ${counts.CACHED}건 · 새로 읽음 ${counts.EXTRACTED}건 · 실패 ${counts.FAILED}건 · 키 없음 ${counts.NOT_CONFIGURED}건 · 너무 김 ${counts.TOO_LONG}건 · 본문 없음 ${counts.NO_TEXT}건 · 입력 ${report.conditions.inputTokens}토큰 · 출력 ${report.conditions.outputTokens}토큰`,
      );
    }
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
    console.error(mask(`오류 [${error.code}] ${error.message}`));
    for (const issue of error.issues ?? []) console.error(mask(`  - [${issue.code}] ${issue.source}: ${issue.detail}`));
  } else {
    console.error(mask(error instanceof Error ? error.message : String(error)));
  }
  process.exitCode = 1;
});
