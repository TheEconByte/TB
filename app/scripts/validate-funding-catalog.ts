import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../src/lib/checksum.ts';
import { todayInKst } from '../src/features/funding/dates.ts';
import { FUNDING_TAB_LABELS } from '../src/features/funding/match-text.ts';
import { FUNDING_TABS, matchCatalog, type FundingMatchProfile } from '../src/features/funding/matching.ts';
import { validateFundingCatalog, type FundingValidationCheck } from '../src/features/funding/validation.ts';

const NO_INPUT: FundingMatchProfile = {
  businessStatus: null,
  openedYearMonth: null,
  districtCode: null,
  age: null,
  targetGroups: null,
};

const DEFAULT_CATALOG = fileURLToPath(new URL('../catalog/funding/catalog.json', import.meta.url));

const USAGE = `운영자가 관리하는 자금 공고 카탈로그를 DB 없이 검사합니다.

사용법:
  npm run funding:validate -- [옵션]

옵션:
  --catalog <경로>    검사할 카탈로그 JSON (기본값: app/catalog/funding/catalog.json)
  -h, --help          이 도움말

검사 항목:
  - JSON 스키마와 필수 필드
  - productKey + version 중복
  - 공식 기관 URL 형식
  - 날짜와 접수기간 모순, 접수 상태(OPEN/CLOSED/UNKNOWN) 모순
  - 지원 유형과 금리·상환 조건 모순
  - checksum 형식과 원문 미확보 상태
  - 금리·기간·상환방식이 미확정인 상품의 상환 계산 사유 누락
  - 조건별 공식 원문 근거 누락

동작:
  - 검증을 우회하는 옵션은 없습니다. 오류가 있으면 종료 코드 1로 끝납니다.`;

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

function printChecks(checks: readonly FundingValidationCheck[]) {
  const labels: Record<FundingValidationCheck['status'], string> = { PASS: '통과', WARN: '주의', FAIL: '실패' };
  for (const check of checks) console.log(`  [${labels[check.status]}] ${check.name}: ${check.detail}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  const asOfDate = todayInKst();
  const bytes = readFileSync(options.catalogPath);
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  const validation = validateFundingCatalog(raw);

  console.log(`카탈로그: ${options.catalogPath}`);
  console.log(`판정 기준일(한국 시간): ${asOfDate}`);
  console.log(`파일 SHA-256: ${sha256Hex(bytes)}`);
  console.log('');
  console.log('검사 결과:');
  printChecks(validation.checks);

  if (validation.warnings.length > 0) {
    console.log('');
    console.log(`주의 ${validation.warnings.length}건:`);
    for (const warning of validation.warnings) console.log(`  [${warning.code}] ${warning.source} ${warning.detail}`);
  }
  if (validation.issues.length > 0) {
    console.log('');
    console.log(`오류 ${validation.issues.length}건:`);
    for (const issue of validation.issues) console.log(`  [${issue.code}] ${issue.source} ${issue.detail}`);
    console.log('');
    console.log('검증 실패: 이 카탈로그는 적재할 수 없습니다.');
    process.exitCode = 1;
    return;
  }

  const catalog = validation.catalog;
  if (catalog === null) {
    console.log('검증 결과가 비어 있습니다.');
    process.exitCode = 1;
    return;
  }
  console.log('');
  console.log(
    `카탈로그: ${catalog.catalogKey}@${catalog.catalogVersion} · schemaVersion ${catalog.schemaVersion} · 기준일 ${catalog.basisDate}`,
  );
  console.log(`상품 ${catalog.products.length}건`);
  const byType = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const product of catalog.products) {
    byType.set(product.supportType, (byType.get(product.supportType) ?? 0) + 1);
    byStatus.set(product.observedApplicationStatus, (byStatus.get(product.observedApplicationStatus) ?? 0) + 1);
  }
  console.log(`  지원 유형: ${[...byType].map(([type, count]) => `${type} ${count}`).join(', ')}`);
  console.log(`  접수 상태(관측): ${[...byStatus].map(([status, count]) => `${status} ${count}`).join(', ')}`);

  // 맞춰 보기의 갈래와 마감이다(ADR 0009 §4). 사용자 입력과 AI가 읽은 조건 없이 본 것이라 맞아 보임은 나오지 않는다.
  // 마감은 출처·운영자의 접수 상태와 신청 종료일로만 정한다.
  const matches = matchCatalog(catalog, new Map(), NO_INPUT, { asOfDate });
  console.log('  맞춰 보기 갈래(사용자 입력·AI 추출 결과 없음 기준):');
  for (const tab of FUNDING_TABS) {
    const { counts, products } = matches.tabs[tab];
    console.log(`    ${FUNDING_TAB_LABELS[tab]} ${products.length}건 (마감 ${counts.CLOSED})`);
  }
  if (matches.hiddenCount > 0) console.log(`    차단 목록이라 보여 주지 않는 자동 상품 ${matches.hiddenCount}건`);
  console.log('');
  console.log(`통과: 상품 ${catalog.products.length}건을 적재할 수 있습니다(주의 ${validation.warnings.length}건).`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
