import { ZodError } from 'zod';
import {
  REPAYABLE_SUPPORT_TYPES,
  REVIEWER_UNASSIGNED,
  REQUIRED_EVIDENCE_SUBJECTS,
  compareIsoDates,
  isSupportedRepaymentMethod,
  isPrimaryRetrievalMethod,
  reviewState,
  type EvidenceSubject,
} from './types.ts';
import { fundingCatalogSchema, productVersionKey, type FundingCatalog, type FundingProduct } from './schema.ts';

export type FundingIssueCode =
  | 'SCHEMA_INVALID'
  | 'DUPLICATE_PRODUCT_VERSION'
  | 'DUPLICATE_EVIDENCE_ID'
  | 'MISSING_EVIDENCE'
  | 'EVIDENCE_NOT_PRIMARY'
  | 'EVIDENCE_OBSERVED_AT_AFTER_BASIS_DATE'
  | 'EVIDENCE_CHECKSUM_NOT_APPLICABLE'
  | 'EVIDENCE_CHECKSUM_MISSING'
  | 'CHECKSUM_MISSING'
  | 'CHECKSUM_NOT_RETRIEVED'
  | 'APPLICATION_PERIOD_CONTRADICTION'
  | 'APPLICATION_PERIOD_NOTE_MISSING'
  | 'OBSERVED_OPEN_AFTER_PERIOD_END'
  | 'OBSERVED_OPEN_BEFORE_PERIOD_START'
  | 'OBSERVED_AT_AFTER_BASIS_DATE'
  | 'REVIEWED_AT_MISSING'
  | 'NEXT_REVIEW_AT_MISSING'
  | 'REVIEWED_AT_BEFORE_OBSERVED_AT'
  | 'REVIEWED_AT_AFTER_BASIS_DATE'
  | 'REVIEW_PERIOD_CONTRADICTION'
  | 'REVIEW_OVERDUE'
  | 'REVIEWER_UNASSIGNED'
  | 'REGION_DISTRICT_CONTRADICTION'
  | 'REGION_DISTRICTS_MISSING'
  | 'INDUSTRY_SCOPE_CONTRADICTION'
  | 'INDUSTRY_INCLUDE_EXCLUDE_CONFLICT'
  | 'PURPOSE_INCLUDE_EXCLUDE_CONFLICT'
  | 'SUPPORT_TYPE_FINANCIAL_CONTRADICTION'
  | 'INTEREST_CONFIRMED_WITHOUT_CONDITION'
  | 'INTEREST_RATE_NOT_CONFIRMED'
  | 'REPAYMENT_PERIOD_CONTRADICTION'
  | 'CALCULATION_REASON_MISSING'
  | 'CALCULATION_REASON_UNEXPECTED'
  | 'CLOSED_BEFORE_PERIOD_END';

export type FundingIssue = { code: FundingIssueCode; source: string; detail: string };

export type FundingCheckStatus = 'PASS' | 'WARN' | 'FAIL';
export type FundingValidationCheck = { name: string; status: FundingCheckStatus; detail: string };

export type FundingCatalogValidation = {
  ok: boolean;
  catalog: FundingCatalog | null;
  issues: FundingIssue[];
  warnings: FundingIssue[];
  errorCounts: Record<string, number>;
  warningCounts: Record<string, number>;
  checks: FundingValidationCheck[];
  // 검토 기한이 지나 현재 후보로 쓸 수 없는 상품. 적재는 막지 않는다.
  reviewOverdue: string[];
};

type CheckCategory = 'schema' | 'duplicates' | 'evidence' | 'dates' | 'support' | 'checksum' | 'review' | 'calculation';

const CATEGORY_LABELS: Record<CheckCategory, string> = {
  schema: 'JSON 스키마',
  duplicates: '상품·버전 중복',
  evidence: '공식 URL·근거',
  dates: '날짜·접수기간',
  support: '지원 유형·금융 조건',
  checksum: 'checksum',
  review: '검수 기한',
  calculation: '상환 계산 조건',
};

const CATEGORY_BY_CODE: Record<FundingIssueCode, CheckCategory> = {
  SCHEMA_INVALID: 'schema',
  DUPLICATE_PRODUCT_VERSION: 'duplicates',
  DUPLICATE_EVIDENCE_ID: 'duplicates',
  MISSING_EVIDENCE: 'evidence',
  EVIDENCE_NOT_PRIMARY: 'evidence',
  EVIDENCE_OBSERVED_AT_AFTER_BASIS_DATE: 'evidence',
  EVIDENCE_CHECKSUM_NOT_APPLICABLE: 'checksum',
  EVIDENCE_CHECKSUM_MISSING: 'checksum',
  CHECKSUM_MISSING: 'checksum',
  CHECKSUM_NOT_RETRIEVED: 'checksum',
  APPLICATION_PERIOD_CONTRADICTION: 'dates',
  APPLICATION_PERIOD_NOTE_MISSING: 'dates',
  OBSERVED_OPEN_AFTER_PERIOD_END: 'dates',
  OBSERVED_OPEN_BEFORE_PERIOD_START: 'dates',
  OBSERVED_AT_AFTER_BASIS_DATE: 'dates',
  REVIEWED_AT_MISSING: 'review',
  NEXT_REVIEW_AT_MISSING: 'review',
  REVIEWED_AT_BEFORE_OBSERVED_AT: 'dates',
  REVIEWED_AT_AFTER_BASIS_DATE: 'dates',
  REVIEW_PERIOD_CONTRADICTION: 'review',
  REVIEW_OVERDUE: 'review',
  REVIEWER_UNASSIGNED: 'review',
  REGION_DISTRICT_CONTRADICTION: 'support',
  REGION_DISTRICTS_MISSING: 'support',
  INDUSTRY_SCOPE_CONTRADICTION: 'support',
  INDUSTRY_INCLUDE_EXCLUDE_CONFLICT: 'support',
  PURPOSE_INCLUDE_EXCLUDE_CONFLICT: 'support',
  SUPPORT_TYPE_FINANCIAL_CONTRADICTION: 'support',
  INTEREST_CONFIRMED_WITHOUT_CONDITION: 'support',
  INTEREST_RATE_NOT_CONFIRMED: 'support',
  REPAYMENT_PERIOD_CONTRADICTION: 'support',
  CALCULATION_REASON_MISSING: 'calculation',
  CALCULATION_REASON_UNEXPECTED: 'calculation',
  CLOSED_BEFORE_PERIOD_END: 'dates',
};

export class FundingCatalogError extends Error {
  readonly code: string;
  readonly issues: FundingIssue[] | undefined;
  readonly errorCounts: Record<string, number> | undefined;

  constructor(
    code: string,
    message: string,
    details?: { issues?: FundingIssue[]; errorCounts?: Record<string, number> },
  ) {
    super(message);
    this.name = 'FundingCatalogError';
    this.code = code;
    this.issues = details?.issues;
    this.errorCounts = details?.errorCounts;
  }
}

const MAX_DETAILS = 50;

type Collector = {
  add(code: FundingIssueCode, source: string, detail: string): void;
  warn(code: FundingIssueCode, source: string, detail: string): void;
  readonly issues: FundingIssue[];
  readonly warnings: FundingIssue[];
  readonly errorCounts: Record<string, number>;
  readonly warningCounts: Record<string, number>;
};

function createCollector(): Collector {
  const issues: FundingIssue[] = [];
  const warnings: FundingIssue[] = [];
  const errorCounts: Record<string, number> = {};
  const warningCounts: Record<string, number> = {};
  const push = (target: FundingIssue[], counts: Record<string, number>, issue: FundingIssue) => {
    counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    if (target.length < MAX_DETAILS) target.push(issue);
  };
  return {
    add: (code, source, detail) => push(issues, errorCounts, { code, source, detail }),
    warn: (code, source, detail) => push(warnings, warningCounts, { code, source, detail }),
    issues,
    warnings,
    errorCounts,
    warningCounts,
  };
}

function overlap(left: readonly string[], right: readonly string[]): string[] {
  return left.filter((value) => right.includes(value));
}

function checkProduct(product: FundingProduct, basisDate: string, collector: Collector): void {
  const source = productVersionKey(product);
  const { applicationPeriod, evidence } = product;

  // 근거: 근거 id 중복, 필수 근거 주제 누락, 근거 관측일.
  const evidenceIds = new Set<string>();
  for (const entry of evidence) {
    if (evidenceIds.has(entry.id)) {
      collector.add('DUPLICATE_EVIDENCE_ID', source, `근거 id '${entry.id}'가 중복입니다.`);
    }
    evidenceIds.add(entry.id);
    if (compareIsoDates(entry.observedAt, basisDate) > 0) {
      collector.add(
        'EVIDENCE_OBSERVED_AT_AFTER_BASIS_DATE',
        source,
        `근거 '${entry.id}'의 확인일 ${entry.observedAt}이(가) 기준일 ${basisDate} 이후입니다.`,
      );
    }
    // 첨부·API만 원문 파일 checksum을 남길 수 있다. 웹 페이지 확인과 검색 요약은
    // 내려받은 파일이 없으므로 checksum이 null이어야 한다.
    const fileBacked = entry.retrievalMethod === 'OFFICIAL_ATTACHMENT' || entry.retrievalMethod === 'OFFICIAL_API';
    if (!fileBacked && entry.checksum !== null) {
      collector.add(
        'EVIDENCE_CHECKSUM_NOT_APPLICABLE',
        source,
        `근거 '${entry.id}'은 원문 파일을 내려받아 확인한 기록이 아니라 checksum을 기록할 수 없습니다.`,
      );
    }
    if (fileBacked && entry.checksum === null) {
      collector.add(
        'EVIDENCE_CHECKSUM_MISSING',
        source,
        `근거 '${entry.id}'은 원문 파일을 내려받아 확인했다고 기록했으나 checksum이 없습니다.`,
      );
    }
    if (!isPrimaryRetrievalMethod(entry.retrievalMethod)) {
      collector.warn(
        'EVIDENCE_NOT_PRIMARY',
        source,
        `근거 '${entry.id}'은 ${entry.retrievalMethod}로 기록되었습니다. 공식 원문 페이지·첨부를 직접 확인해 다시 검수해야 합니다.`,
      );
    }
  }
  const subjects = new Set<EvidenceSubject>(evidence.map((entry) => entry.subject));
  const required: EvidenceSubject[] = [...REQUIRED_EVIDENCE_SUBJECTS];
  if (product.supportType === 'LOAN' || product.supportType === 'GUARANTEE') required.push('FINANCIAL_CONDITION');
  if (product.region.scope !== 'UNKNOWN') required.push('REGION');
  if (product.purpose.included.length > 0 || product.purpose.excluded.length > 0) required.push('PURPOSE');
  if (product.industryConditions.scope !== 'UNKNOWN') required.push('INDUSTRY');
  for (const subject of new Set(required)) {
    if (!subjects.has(subject)) {
      collector.add('MISSING_EVIDENCE', source, `${subject} 조건의 공식 원문 근거가 없습니다.`);
    }
  }

  // 원본 checksum: 내려받지 않았으면 null, 내려받았으면 실제 sha256이 있어야 한다.
  if (product.sourceDocumentRetrieved && product.sourceChecksum === null) {
    collector.add(
      'CHECKSUM_MISSING',
      source,
      `원문 '${product.sourceDocumentName}'을 내려받아 확인했다고 기록했으나 checksum이 없습니다.`,
    );
  }
  if (!product.sourceDocumentRetrieved && product.sourceChecksum !== null) {
    collector.add(
      'CHECKSUM_NOT_RETRIEVED',
      source,
      '원문 파일을 내려받지 않았다고 기록했는데 checksum이 있습니다. 확인하지 않은 파일의 checksum을 기록하지 마세요.',
    );
  }

  // 접수기간 자체의 모순.
  if (
    applicationPeriod.start !== null &&
    applicationPeriod.end !== null &&
    compareIsoDates(applicationPeriod.end, applicationPeriod.start) < 0
  ) {
    collector.add(
      'APPLICATION_PERIOD_CONTRADICTION',
      source,
      `신청기간 종료일 ${applicationPeriod.end}이(가) 시작일 ${applicationPeriod.start}보다 앞섭니다.`,
    );
  }
  if (applicationPeriod.start === null && applicationPeriod.end === null && applicationPeriod.note === null) {
    collector.add(
      'APPLICATION_PERIOD_NOTE_MISSING',
      source,
      '신청기간을 날짜로 기록하지 않았으면 왜 기록할 수 없는지(예: 예산 소진 시까지) note에 남겨야 합니다.',
    );
  }
  if (
    product.observedApplicationStatus === 'OPEN' &&
    applicationPeriod.end !== null &&
    compareIsoDates(applicationPeriod.end, product.observedAt) < 0
  ) {
    collector.add(
      'OBSERVED_OPEN_AFTER_PERIOD_END',
      source,
      `신청기간이 ${applicationPeriod.end}에 끝났는데 ${product.observedAt} 기준 접수 상태가 OPEN입니다.`,
    );
  }
  if (
    product.observedApplicationStatus === 'OPEN' &&
    applicationPeriod.start !== null &&
    compareIsoDates(product.observedAt, applicationPeriod.start) < 0
  ) {
    collector.add(
      'OBSERVED_OPEN_BEFORE_PERIOD_START',
      source,
      `신청 시작일 ${applicationPeriod.start} 전인 ${product.observedAt} 기준으로 접수 상태를 OPEN으로 기록했습니다.`,
    );
  }
  if (
    product.observedApplicationStatus === 'CLOSED' &&
    applicationPeriod.end !== null &&
    compareIsoDates(applicationPeriod.end, product.observedAt) > 0
  ) {
    collector.warn(
      'CLOSED_BEFORE_PERIOD_END',
      source,
      `신청기간 종료일 ${applicationPeriod.end} 전인 ${product.observedAt}에 종료로 확인했습니다. 조기 마감이면 그 근거를 추가하세요.`,
    );
  }

  // 확인일·검수일.
  if (compareIsoDates(product.observedAt, basisDate) > 0) {
    collector.add(
      'OBSERVED_AT_AFTER_BASIS_DATE',
      source,
      `접수 상태 확인일 ${product.observedAt}이(가) 기준일 ${basisDate} 이후입니다.`,
    );
  }
  if (product.reviewedAt === null) {
    collector.add(
      'REVIEWED_AT_MISSING',
      source,
      'reviewedAt이 없습니다. 검수하지 않은 상품은 현재 후보로 취급하지 않습니다.',
    );
  } else {
    if (compareIsoDates(product.reviewedAt, product.observedAt) < 0) {
      collector.add(
        'REVIEWED_AT_BEFORE_OBSERVED_AT',
        source,
        `검수일 ${product.reviewedAt}이(가) 확인일 ${product.observedAt}보다 앞섭니다.`,
      );
    }
    if (compareIsoDates(product.reviewedAt, basisDate) > 0) {
      collector.add(
        'REVIEWED_AT_AFTER_BASIS_DATE',
        source,
        `검수일 ${product.reviewedAt}이(가) 기준일 ${basisDate} 이후입니다.`,
      );
    }
  }
  if (product.nextReviewAt === null) {
    collector.add(
      'NEXT_REVIEW_AT_MISSING',
      source,
      'nextReviewAt이 없습니다. 다음 검토일 없는 상품은 현재 후보로 취급하지 않습니다.',
    );
  } else if (product.reviewedAt !== null && compareIsoDates(product.nextReviewAt, product.reviewedAt) < 0) {
    collector.add(
      'REVIEW_PERIOD_CONTRADICTION',
      source,
      `다음 검토일 ${product.nextReviewAt}이(가) 검수일 ${product.reviewedAt}보다 앞섭니다.`,
    );
  }

  // 지역 조건.
  const { region, industryConditions, purpose } = product;
  if (region.scope !== 'DISTRICTS' && region.districtCodes.length > 0) {
    collector.add(
      'REGION_DISTRICT_CONTRADICTION',
      source,
      `지역 범위가 ${region.scope}인데 자치구 코드를 나열했습니다.`,
    );
  }
  if (region.scope === 'DISTRICTS' && region.districtCodes.length === 0) {
    collector.add('REGION_DISTRICTS_MISSING', source, '지역 범위가 DISTRICTS이면 자치구 코드가 하나 이상 필요합니다.');
  }
  if (
    industryConditions.scope === 'UNRESTRICTED' &&
    (industryConditions.included.length > 0 || industryConditions.excluded.length > 0)
  ) {
    collector.add(
      'INDUSTRY_SCOPE_CONTRADICTION',
      source,
      '업종 조건이 UNRESTRICTED인데 포함·제외 업종을 나열했습니다.',
    );
  }
  if (
    industryConditions.scope === 'LISTED' &&
    industryConditions.included.length === 0 &&
    industryConditions.excluded.length === 0
  ) {
    collector.add(
      'INDUSTRY_SCOPE_CONTRADICTION',
      source,
      '업종 조건이 LISTED이면 포함 또는 제외 업종이 있어야 합니다.',
    );
  }
  const industryOverlap = overlap(industryConditions.included, industryConditions.excluded);
  if (industryOverlap.length > 0) {
    collector.add(
      'INDUSTRY_INCLUDE_EXCLUDE_CONFLICT',
      source,
      `업종 ${industryOverlap.join(', ')}이(가) 포함과 제외에 함께 있습니다.`,
    );
  }
  const purposeOverlap = overlap(purpose.included, purpose.excluded);
  if (purposeOverlap.length > 0) {
    collector.add(
      'PURPOSE_INCLUDE_EXCLUDE_CONFLICT',
      source,
      `용도 ${purposeOverlap.join(', ')}이(가) 포함과 제외에 함께 있습니다.`,
    );
  }

  // 지원 유형과 금융 조건.
  const repayable = REPAYABLE_SUPPORT_TYPES.includes(product.supportType);
  const structuredTerms =
    product.interestRatePercent !== null ||
    product.repaymentTermMonths !== null ||
    product.repaymentGraceMonths !== null;
  if (!repayable) {
    if (product.interestCondition !== null || product.repaymentCondition !== null) {
      collector.add(
        'SUPPORT_TYPE_FINANCIAL_CONTRADICTION',
        source,
        `지원 유형 ${product.supportType}인데 금리·상환 조건을 기록했습니다. 지원금·보증·공간·프로그램 지원은 대출이 아닙니다.`,
      );
    }
    if (product.repaymentMethod !== 'NOT_APPLICABLE') {
      collector.add(
        'SUPPORT_TYPE_FINANCIAL_CONTRADICTION',
        source,
        `지원 유형 ${product.supportType}의 상환방식은 NOT_APPLICABLE이어야 합니다.`,
      );
    }
    if (product.interestRateConfirmed) {
      collector.add(
        'SUPPORT_TYPE_FINANCIAL_CONTRADICTION',
        source,
        `지원 유형 ${product.supportType}인데 금리가 확정되었다고 기록했습니다.`,
      );
    }
    if (structuredTerms) {
      collector.add(
        'SUPPORT_TYPE_FINANCIAL_CONTRADICTION',
        source,
        `지원 유형 ${product.supportType}인데 확정 금리·상환기간·거치 조건을 기록했습니다. 지원금·보증·공간·프로그램 지원은 대출이 아닙니다.`,
      );
    }
  } else if (product.repaymentMethod === 'NOT_APPLICABLE') {
    collector.add(
      'SUPPORT_TYPE_FINANCIAL_CONTRADICTION',
      source,
      `지원 유형 ${product.supportType}의 상환방식을 NOT_APPLICABLE로 기록했습니다. 확인되지 않았으면 UNKNOWN입니다.`,
    );
  }
  if (product.interestRateConfirmed && product.interestCondition === null) {
    collector.add(
      'INTEREST_CONFIRMED_WITHOUT_CONDITION',
      source,
      '금리가 확정되었다고 기록했으나 interestCondition이 없습니다.',
    );
  }
  if (!product.interestRateConfirmed && product.interestRatePercent !== null) {
    collector.add(
      'INTEREST_RATE_NOT_CONFIRMED',
      source,
      '확정 금리 숫자를 기록했으나 interestRateConfirmed가 false입니다. 원문에 확정된 고정 금리가 있을 때만 true로 기록하세요.',
    );
  }
  if (
    product.repaymentTermMonths !== null &&
    product.repaymentGraceMonths !== null &&
    product.repaymentGraceMonths >= product.repaymentTermMonths
  ) {
    collector.add(
      'REPAYMENT_PERIOD_CONTRADICTION',
      source,
      `거치개월 ${product.repaymentGraceMonths}이(가) 전체 상환개월 ${product.repaymentTermMonths}보다 길거나 같습니다.`,
    );
  }

  // 상환 계산 가능 여부. 불명확한 값을 0원 상환으로 표시하지 않도록 사유를 요구한다.
  const calculationReasons: string[] = [];
  if (!repayable) {
    calculationReasons.push(`지원 유형 ${product.supportType}은 대출 원금·상환 일정으로 변환하지 않습니다.`);
  } else {
    if (product.publicLimit === null) calculationReasons.push('공개 한도가 확인되지 않았습니다.');
    if (!product.interestRateConfirmed || product.interestRatePercent === null)
      calculationReasons.push('금리가 확정되지 않았습니다.');
    if (!isSupportedRepaymentMethod(product.repaymentMethod)) {
      calculationReasons.push(`상환방식 ${product.repaymentMethod}은(는) 현재 계산 엔진이 지원하지 않습니다.`);
    }
    if (product.repaymentTermMonths === null || product.repaymentGraceMonths === null)
      calculationReasons.push('상환기간·거치 조건이 확인되지 않았습니다.');
  }
  if (calculationReasons.length > 0 && product.unsupportedCalculationReasons.length === 0) {
    collector.add(
      'CALCULATION_REASON_MISSING',
      source,
      `상품 조건 기반 상환 계산을 제공할 수 없습니다. 사유를 unsupportedCalculationReasons에 기록하세요: ${calculationReasons.join(' / ')}`,
    );
  }
  if (calculationReasons.length === 0 && product.unsupportedCalculationReasons.length > 0) {
    collector.add(
      'CALCULATION_REASON_UNEXPECTED',
      source,
      `확정 조건이 모두 있어 상환 계산을 제공할 수 있는데 unsupportedCalculationReasons가 남아 있습니다. 조건이 아니면 additionalChecks로 옮기세요: ${product.unsupportedCalculationReasons.join(' / ')}`,
    );
  }

  if (product.reviewer === REVIEWER_UNASSIGNED) {
    collector.warn(
      'REVIEWER_UNASSIGNED',
      source,
      '검수자가 지정되지 않았습니다(UNASSIGNED). 운영 공개 전에 실제 검수자를 지정해야 합니다.',
    );
  }
  if (reviewState(product, basisDate) === 'REVIEW_OVERDUE') {
    collector.warn(
      'REVIEW_OVERDUE',
      source,
      `다음 검토일 ${product.nextReviewAt ?? '없음'}이(가) 기준일 ${basisDate} 이전입니다. 현재 후보에서 제외하고 재확인 대상으로만 남깁니다.`,
    );
  }
}

export function validateFundingCatalog(raw: unknown, options: { asOfDate: string }): FundingCatalogValidation {
  const collector = createCollector();
  const parsed = fundingCatalogSchema.safeParse(raw);

  if (!parsed.success) {
    const error = parsed.error;
    const details = error instanceof ZodError ? error.issues : [];
    collector.add(
      'SCHEMA_INVALID',
      'catalog',
      `JSON 스키마 검증에 실패했습니다: ${details
        .slice(0, 10)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join(' | ')}`,
    );
    return {
      ok: false,
      catalog: null,
      issues: collector.issues,
      warnings: collector.warnings,
      errorCounts: collector.errorCounts,
      warningCounts: collector.warningCounts,
      checks: buildChecks(collector),
      reviewOverdue: [],
    };
  }

  const catalog = parsed.data;
  const seen = new Set<string>();
  const reviewOverdue: string[] = [];
  for (const product of catalog.products) {
    const key = productVersionKey(product);
    if (seen.has(key)) {
      collector.add(
        'DUPLICATE_PRODUCT_VERSION',
        key,
        '같은 productKey + version이 카탈로그에 두 번 있습니다. 새 버전 번호로 추가하세요.',
      );
      continue;
    }
    seen.add(key);
    checkProduct(product, catalog.basisDate, collector);
    if (reviewState(product, options.asOfDate) === 'REVIEW_OVERDUE') reviewOverdue.push(key);
  }
  if (catalog.reviewer === REVIEWER_UNASSIGNED) {
    collector.warn('REVIEWER_UNASSIGNED', 'catalog', '카탈로그 검수자가 지정되지 않았습니다(UNASSIGNED).');
  }

  return {
    ok: collector.issues.length === 0,
    catalog,
    issues: collector.issues,
    warnings: collector.warnings,
    errorCounts: collector.errorCounts,
    warningCounts: collector.warningCounts,
    checks: buildChecks(collector),
    reviewOverdue,
  };
}

function buildChecks(collector: Collector): FundingValidationCheck[] {
  const categories = Object.keys(CATEGORY_LABELS) as CheckCategory[];
  return categories.map((category) => {
    const failed = collector.issues.filter((issue) => CATEGORY_BY_CODE[issue.code] === category);
    const warned = collector.warnings.filter((issue) => CATEGORY_BY_CODE[issue.code] === category);
    const status: FundingCheckStatus = failed.length > 0 ? 'FAIL' : warned.length > 0 ? 'WARN' : 'PASS';
    const first = failed[0] ?? warned[0];
    const detail =
      status === 'PASS'
        ? '문제 없음'
        : `${status === 'FAIL' ? '오류' : '주의'} ${(status === 'FAIL' ? failed : warned).length}건. 예: [${first.code}] ${first.source} ${first.detail}`;
    return { name: CATEGORY_LABELS[category], status, detail };
  });
}

// The commands and the loader always validate first; a failing catalog never
// reaches the database.
export function requireValidFundingCatalog(raw: unknown, options: { asOfDate: string }): FundingCatalogValidation {
  const validation = validateFundingCatalog(raw, options);
  if (!validation.ok) {
    const summary = Object.entries(validation.errorCounts)
      .map(([code, count]) => `${code} ${count}건`)
      .join(', ');
    const first = validation.issues[0];
    throw new FundingCatalogError(
      'CATALOG_VALIDATION_FAILED',
      `카탈로그 검증에 실패했습니다: ${summary}. 첫 문제: [${first.code}] ${first.source} ${first.detail}`,
      { issues: validation.issues, errorCounts: validation.errorCounts },
    );
  }
  return validation;
}
