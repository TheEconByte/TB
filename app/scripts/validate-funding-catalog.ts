import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../src/lib/checksum.ts';
import { todayInKst } from '../src/features/funding/dates.ts';
import { evaluateCandidates, UNKNOWN_FUNDING_PROFILE } from '../src/features/funding/eligibility.ts';
import { validateFundingCatalog, type FundingValidationCheck } from '../src/features/funding/validation.ts';
import { REVIEWER_UNASSIGNED } from '../src/features/funding/types.ts';

const DEFAULT_CATALOG = fileURLToPath(new URL('../catalog/funding/catalog.json', import.meta.url));

const USAGE = `검수된 자금 공고 카탈로그를 DB 없이 검사합니다.

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
  - 검수 기한 경과
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
  const validation = validateFundingCatalog(raw, { asOfDate });

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
  console.log(
    `  검수 기한 경과: ${validation.reviewOverdue.length === 0 ? '없음' : validation.reviewOverdue.join(', ')}`,
  );

  // 입력 정보가 없는 기준의 상태 분포다. 사용자별 매칭 결과가 아니다.
  const candidates = evaluateCandidates(catalog, UNKNOWN_FUNDING_PROFILE, { asOfDate });
  console.log('  후보 상태(입력 정보 없음 기준):');
  for (const [status, count] of Object.entries(candidates.summary)) {
    if (status === 'total') continue;
    console.log(`    ${status} ${count}`);
  }
  console.log('');
  const reviewerAssigned =
    catalog.reviewer !== REVIEWER_UNASSIGNED &&
    catalog.products.every((product) => product.reviewer !== REVIEWER_UNASSIGNED);
  if (reviewerAssigned) {
    console.log(
      `통과: 상품 ${catalog.products.length}건을 운영 적재할 수 있는 상태입니다(주의 ${validation.warnings.length}건).`,
    );
  } else {
    console.log(
      `구조 검증 통과: 상품 ${catalog.products.length}건입니다. 검수자가 지정되지 않아 운영 적재는 차단됩니다(주의 ${validation.warnings.length}건).`,
    );
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
