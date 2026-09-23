export const MARKET_SCHEMA_VERSION = 'market-schema-v1.1.0';
export const MARKET_DEFINITION_VERSION = 'seoul-market-definition-2024-2025-v2';
export const INDUSTRY_CATEGORY_VERSION = 'seoul-service-industry-2024-2025';

// Recorded from the 영역-상권 attribute file: A 골목상권, D 발달상권, R 전통시장, U 관광특구.
export const AREA_TYPES = ['A', 'D', 'R', 'U'] as const;
export type AreaType = (typeof AREA_TYPES)[number];

export type DisplayNameSource = 'PRODUCT_DOCUMENT' | 'AREA_FILE' | 'OBSERVED_FILE' | 'SOURCE_FILE';

// Product-document display names for the industries this release exposes.
// Priority for an industry display name is PRODUCT_DOCUMENT first, then the
// name recorded in the source files.
export const SUPPORTED_INDUSTRIES: readonly { code: string; displayName: string }[] = [
  { code: 'CS100001', displayName: '한식' },
  { code: 'CS100010', displayName: '커피·음료' },
];

export const SUPPORTED_INDUSTRY_CODES: readonly string[] = SUPPORTED_INDUSTRIES.map((item) => item.code);

export function supportedIndustry(code: string) {
  return SUPPORTED_INDUSTRIES.find((item) => item.code === code) ?? null;
}

export type IndicatorKey =
  | 'salesAmount'
  | 'salesCount'
  | 'storeCount'
  | 'similarIndustryStoreCount'
  | 'franchiseStoreCount'
  | 'openedStoreCount'
  | 'closedStoreCount';

export type IndicatorDefinition = {
  key: IndicatorKey;
  label: string;
  unit: '원' | '개';
  unitConfirmed: boolean;
  sourceColumn: { 2024: string; 2025: string };
  note: string;
};

export const INDICATOR_DEFINITIONS: readonly IndicatorDefinition[] = [
  {
    key: 'salesAmount',
    label: '서울시 상권분석서비스 추정매출 원값',
    unit: '원',
    unitConfirmed: false,
    sourceColumn: { 2024: '당월_매출_금액', 2025: '당월_매출_금액' },
    note: '출처 열 그대로의 금액입니다. 월 합계인지 분기 합계인지 확정되지 않아 월매출로 환산하지 않습니다.',
  },
  {
    key: 'salesCount',
    label: '추정매출 건수 원값',
    unit: '개',
    unitConfirmed: true,
    sourceColumn: { 2024: '당월_매출_건수', 2025: '당월_매출_건수' },
    note: '출처 열 그대로의 매출 건수입니다. 방문자 수나 주문자 수로 해석하지 않습니다.',
  },
  {
    key: 'storeCount',
    label: '일반 점포 수',
    unit: '개',
    unitConfirmed: true,
    sourceColumn: { 2024: '점포_수', 2025: 'stor_co' },
    note: '출처 열 점포_수(stor_co)입니다. 프랜차이즈 점포를 제외한 값이며 전체 점포 수가 아닙니다.',
  },
  {
    key: 'similarIndustryStoreCount',
    label: '유사 업종 점포 수',
    unit: '개',
    unitConfirmed: true,
    sourceColumn: { 2024: '유사_업종_점포_수', 2025: 'similr_induty_stor_co' },
    note: '출처 열 유사_업종_점포_수입니다. 일반 점포 수 + 프랜차이즈 점포 수와 일치하는 것으로 확인했습니다.',
  },
  {
    key: 'franchiseStoreCount',
    label: '프랜차이즈 점포 수',
    unit: '개',
    unitConfirmed: true,
    sourceColumn: { 2024: '프랜차이즈_점포_수', 2025: 'frc_stor_co' },
    note: '출처 열 프랜차이즈_점포_수입니다.',
  },
  {
    key: 'openedStoreCount',
    label: '개업 점포 수',
    unit: '개',
    unitConfirmed: true,
    sourceColumn: { 2024: '개업_점포_수', 2025: 'opbiz_stor_co' },
    note: '출처 열 개업_점포_수입니다. 개업_율의 분모는 이 화면에서 사용하지 않습니다.',
  },
  {
    key: 'closedStoreCount',
    label: '폐업 점포 수',
    unit: '개',
    unitConfirmed: true,
    sourceColumn: { 2024: '폐업_점포_수', 2025: 'clsbiz_stor_co' },
    note: '출처 열 폐업_점포_수입니다. 폐업_률의 분모는 이 화면에서 사용하지 않습니다.',
  },
];

// Shown verbatim in the API response and on the exploration screen.
export const MARKET_LIMITATIONS: readonly string[] = [
  '공개 상권 지표이며 개인 점포의 예상매출이 아닙니다.',
  '매출 원값의 월·분기 단위가 확정되지 않아 월매출로 환산하지 않습니다.',
  '점포당 매출을 계산하지 않습니다.',
  '자료가 없는 조합은 0으로 채우지 않고 자료 부족으로 표시합니다.',
  '상권 원값을 재무계획의 월매출 가정에 자동으로 입력하지 않습니다.',
];

export type QuarterIndicatorRow = {
  quarter: string;
  label: string;
  salesAmount: string | null;
  salesCount: string | null;
  salesBreakdown: SalesBreakdown | null;
  salesStatus: 'OBSERVED' | 'NOT_PROVIDED';
  storeCount: number | null;
  similarIndustryStoreCount: number | null;
  franchiseStoreCount: number | null;
  openedStoreCount: number | null;
  closedStoreCount: number | null;
};

export type SalesBreakdownPoint = {
  key: string;
  label: string;
  salesAmount: string;
  salesCount: string;
};

export type SalesBreakdown = {
  schemaVersion: 'market-sales-breakdown-v1.0.0';
  dayOfWeek: SalesBreakdownPoint[];
  timeOfDay: SalesBreakdownPoint[];
  gender: SalesBreakdownPoint[];
  age: SalesBreakdownPoint[];
  limitations: string[];
};

export type ReleaseInfo = {
  releaseKey: string;
  label: string;
  basisPeriod: string;
  basisPeriodLabel: string;
  retrievedAt: string;
  activatedAt: string | null;
  schemaVersion: string;
  definitionVersion: string;
  sourceUrl: string;
  areaCount: number;
  quarterlyRowCount: number;
  sources: {
    datasetId: string;
    datasetName: string;
    url: string;
    basisPeriod: string;
    fileName: string;
    sha256: string;
  }[];
};

export type AreaInfo = {
  areaType: string;
  areaCode: string;
  displayName: string;
  displayNameSource: DisplayNameSource;
  sourceName: string;
  observedName: string | null;
  nameMismatch: boolean;
  areaTypeName: string;
  districtCode: string;
  districtName: string;
};

export type IndustryInfo = {
  code: string;
  sourceName: string;
  displayName: string;
  displayNameSource: DisplayNameSource;
  sourceCategoryVersion: string;
};

export type MarketSummary = {
  release: ReleaseInfo;
  area: AreaInfo;
  industry: IndustryInfo;
  availableQuarters: { quarter: string; label: string }[];
  quarters: QuarterIndicatorRow[];
  dataStatus: 'AVAILABLE' | 'PARTIAL' | 'NOT_PROVIDED';
  dataStatusMessage: string | null;
  indicators: readonly IndicatorDefinition[];
  limitations: readonly string[];
};

export type MarketReport = MarketSummary & {
  observedScope: {
    kind: 'BROAD_INDUSTRY';
    code: string;
    label: string;
    statement: string;
  };
  competitionScope: null;
  sourceRelease: string;
  asOf: string | null;
  nullReason: string | null;
};

export type MarketAreaList = {
  release: ReleaseInfo;
  districts: { districtCode: string; districtName: string; areaCount: number }[];
  areas: AreaInfo[];
  filter: { districtCode: string | null };
  limitations: readonly string[];
};

export type IndustryList = {
  activeRelease: ReleaseInfo | null;
  industries: IndustryInfo[];
  limitations: readonly string[];
};
