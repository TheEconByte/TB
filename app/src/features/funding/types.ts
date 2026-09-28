// Shared vocabulary for the human-reviewed funding catalog. These values are
// stored as-is in the JSON catalog and mirrored by the Prisma enums, so a name
// change here is a catalog schema change too.

export const FUNDING_CATALOG_SCHEMA_VERSION = 'funding-catalog-v1.1.0';

// 이미 적재된 릴리스를 읽을 수 있는 스키마 버전. v1.1.0은 v1.0.0에 출처 식별자와
// 자동화 설정을 더했을 뿐이라 v1.0.0 릴리스도 그대로 읽는다.
export const READABLE_FUNDING_CATALOG_SCHEMA_VERSIONS: readonly string[] = [
  'funding-catalog-v1.0.0',
  FUNDING_CATALOG_SCHEMA_VERSION,
];

// A product whose reviewer is still unassigned is kept in the catalog but the
// operator commands warn: a real person must own the next review before the
// catalog drives anything user-facing.
export const REVIEWER_UNASSIGNED = 'UNASSIGNED';

// funding:sync가 공식 출처에서 모은 상품의 검수자. 사람 대신 자동 규칙 버전을 적고,
// 규칙을 바꾸면 버전을 올린다(ADR 0006).
export const AUTO_REVIEWER_PREFIX = 'AUTO:';
export const FUNDING_AUTOMATION_RULES_VERSION = 'funding-auto-v1';
export const AUTO_REVIEWER = `${AUTO_REVIEWER_PREFIX}${FUNDING_AUTOMATION_RULES_VERSION}`;

export function isAutoReviewer(reviewer: string): boolean {
  return reviewer.startsWith(AUTO_REVIEWER_PREFIX);
}

// funding:sync가 상품을 모으는 공식 출처.
export const FUNDING_SOURCES = ['SEMAS_OLS'] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

export const FUNDING_SOURCE_LABELS: Record<FundingSource, string> = {
  SEMAS_OLS: '소상공인시장진흥공단 정책자금 사이트',
};

// 출처의 마지막 성공 동기화가 이 일수를 넘기면 그 출처의 자동 상품은 현재 후보에서 빠진다.
export const SOURCE_FRESHNESS_DAYS = 3;

export const SUPPORT_TYPES = ['GRANT', 'GUARANTEE', 'LOAN', 'SPACE', 'PROGRAM'] as const;
export type SupportType = (typeof SUPPORT_TYPES)[number];

// GRANT is a non-repayable subsidy. GUARANTEE, LOAN, SPACE and PROGRAM do not
// repay the same way, so only LOAN products can ever reach repayment math.
export const REPAYABLE_SUPPORT_TYPES: readonly SupportType[] = ['LOAN'];

// 정책자금 갈래(대출·보증). ADR 0006에 따라 자동 승격은 이 갈래에만 쓴다. 지원금·공간·
// 프로그램(지원사업)은 자동으로 모아도 사람이 확인해야 현재 후보가 된다.
export const POLICY_LOAN_SUPPORT_TYPES: readonly SupportType[] = ['LOAN', 'GUARANTEE'];

export const BUSINESS_STAGES = ['PRE_REGISTRATION', 'POST_REGISTRATION'] as const;
export type BusinessStage = (typeof BUSINESS_STAGES)[number];

export const OBSERVED_APPLICATION_STATUSES = ['OPEN', 'CLOSED', 'UNKNOWN'] as const;
export type ObservedApplicationStatus = (typeof OBSERVED_APPLICATION_STATUSES)[number];

// Eligibility verdicts are separate from the observed application status: a
// product can be OPEN while a condition remains UNKNOWN.
export const VERDICTS = ['PASS', 'FAIL', 'UNKNOWN'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const REPAYMENT_METHODS = [
  'EQUAL_INSTALLMENT',
  'EQUAL_PRINCIPAL',
  'BULLET',
  'INTEREST_ONLY',
  'NOT_APPLICABLE',
  'UNKNOWN',
] as const;
export type RepaymentMethod = (typeof REPAYMENT_METHODS)[number];

// The F1 engine supports 원리금균등 and 원금균등 only. Everything else must stay
// uncalculated instead of being shown as a 0원 repayment.
export const SUPPORTED_REPAYMENT_METHODS: readonly RepaymentMethod[] = ['EQUAL_INSTALLMENT', 'EQUAL_PRINCIPAL'];

export function isSupportedRepaymentMethod(method: RepaymentMethod): boolean {
  return SUPPORTED_REPAYMENT_METHODS.includes(method);
}

export const PURPOSES = [
  'STARTUP_COST',
  'FACILITY_EQUIPMENT',
  'OPERATING_FUNDS',
  'MARKETING',
  'SPACE_RENT',
  'PROGRAM_TRAINING',
  'RND',
  'OTHER',
] as const;
export type Purpose = (typeof PURPOSES)[number];

export const REGION_SCOPES = ['NATIONWIDE', 'SEOUL', 'DISTRICTS', 'UNKNOWN'] as const;
export type RegionScope = (typeof REGION_SCOPES)[number];

export const INDUSTRY_SCOPES = ['UNRESTRICTED', 'LISTED', 'UNKNOWN'] as const;
export type IndustryScope = (typeof INDUSTRY_SCOPES)[number];

// 상권 업종 코드(예: CS100010) 형식. 카탈로그 스키마와 두 화면(자금 후보 조회,
// 계획 화면)이 같은 규칙을 쓰도록 한 곳에서 정의한다.
export const INDUSTRY_CODE_PATTERN = /^[A-Z]{2}\d{6}$/;

// Every condition a product version must cite back to a reviewed source.
export const EVIDENCE_SUBJECTS = [
  'IDENTITY',
  'APPLICATION_PERIOD',
  'BUSINESS_STAGE',
  'ELIGIBILITY_CONDITION',
  'FINANCIAL_CONDITION',
  'REGION',
  'PURPOSE',
  'INDUSTRY',
] as const;
export type EvidenceSubject = (typeof EVIDENCE_SUBJECTS)[number];

export const REQUIRED_EVIDENCE_SUBJECTS: readonly EvidenceSubject[] = [
  'IDENTITY',
  'APPLICATION_PERIOD',
  'BUSINESS_STAGE',
];

export const RETRIEVAL_METHODS = [
  'OFFICIAL_WEB_PAGE',
  'OFFICIAL_ATTACHMENT',
  'OFFICIAL_API',
  'SEARCH_RESULT_SUMMARY',
] as const;
export type RetrievalMethod = (typeof RETRIEVAL_METHODS)[number];

// A search-result summary is not the original document. It is recorded so the
// review trail is honest, but it never counts as a confirmed condition.
export const PRIMARY_RETRIEVAL_METHODS: readonly RetrievalMethod[] = [
  'OFFICIAL_WEB_PAGE',
  'OFFICIAL_ATTACHMENT',
  'OFFICIAL_API',
];

export function isPrimaryRetrievalMethod(method: RetrievalMethod): boolean {
  return PRIMARY_RETRIEVAL_METHODS.includes(method);
}

// Only government, public-institution and Seoul metropolitan hosts may be used
// as product sources. Search-result summaries and press articles never qualify.
export const OFFICIAL_URL_HOST_SUFFIXES: readonly string[] = [
  'bizinfo.go.kr',
  'mss.go.kr',
  'k-startup.go.kr',
  'seoul.go.kr',
  'seoulcareerup.or.kr',
  'kinfa.or.kr',
  'semas.or.kr',
  'sbiz.or.kr',
  'seoulshinbo.co.kr',
  'seoulcredit.co.kr',
  'sba.seoul.kr',
  'startup.go.kr',
];

export function isOfficialUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return OFFICIAL_URL_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: string): boolean {
  return ISO_DATE_PATTERN.test(value);
}

// Rejects 2026-02-30 style values that pass the shape test but do not exist.
export function isRealDate(value: string): boolean {
  if (!isIsoDate(value)) return false;
  const [year, month, day] = value.split('-').map((part) => Number(part));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// ISO dates compare correctly as strings, so no Date arithmetic is needed.
export function compareIsoDates(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export type ReviewState = 'CURRENT' | 'UNREVIEWED' | 'REVIEW_OVERDUE';

// 출처별 마지막 성공 동기화일. 자동 상품의 최신성은 사람이 정한 다음 검토일 대신 이 날짜로 판단한다.
export type SourceFreshness = { source: FundingSource; lastSucceededOn: string | null };

// 자동 상품은 출처의 마지막 성공 동기화가 SOURCE_FRESHNESS_DAYS 안이어야 최신이다.
// 동기화 기록이 없거나 성공한 적이 없으면 최신이 아니다.
export function isSourceFresh(
  source: FundingSource,
  sourceSyncs: readonly SourceFreshness[],
  asOfDate: string,
): boolean {
  const sync = sourceSyncs.find((entry) => entry.source === source);
  if (!sync || sync.lastSucceededOn === null) return false;
  return compareIsoDates(addDaysToIsoDate(sync.lastSucceededOn, SOURCE_FRESHNESS_DAYS), asOfDate) >= 0;
}

// A product with no review date at all is treated as overdue: it can never be
// presented as currently applicable. 자동 상품은 다음 검토일 대신 출처 최신성으로 판단한다.
export function reviewState(
  product: {
    reviewer: string;
    reviewedAt: string | null;
    nextReviewAt: string | null;
    sourceRef?: { source: FundingSource } | undefined;
  },
  asOfDate: string,
  sourceSyncs: readonly SourceFreshness[] = [],
): ReviewState {
  if (isAutoReviewer(product.reviewer)) {
    if (product.reviewedAt === null || product.sourceRef === undefined) return 'REVIEW_OVERDUE';
    return isSourceFresh(product.sourceRef.source, sourceSyncs, asOfDate) ? 'CURRENT' : 'REVIEW_OVERDUE';
  }
  if (product.reviewedAt === null || product.nextReviewAt === null) return 'REVIEW_OVERDUE';
  if (compareIsoDates(product.nextReviewAt, asOfDate) < 0) return 'REVIEW_OVERDUE';
  return product.reviewer === REVIEWER_UNASSIGNED ? 'UNREVIEWED' : 'CURRENT';
}

// FAIL beats UNKNOWN, UNKNOWN beats PASS. An empty condition set is UNKNOWN
// because nothing was actually verified.
export function combineVerdicts(verdicts: readonly Verdict[]): Verdict {
  if (verdicts.includes('FAIL')) return 'FAIL';
  if (verdicts.includes('UNKNOWN')) return 'UNKNOWN';
  return verdicts.length > 0 ? 'PASS' : 'UNKNOWN';
}
