// 공정거래위원회 가맹정보(공공데이터포털 Open API). 운영자 적재 명령에서만 호출하고,
// 웹 요청 중에는 적재된 스냅샷만 읽는다.
export const FRANCHISE_SCHEMA_VERSION = 'ftc-franchise-v1.0.0';
export const FRANCHISE_SOURCE_NAME = '공정거래위원회 가맹사업 정보공개서(공공데이터포털 가맹정보)';
export const FRANCHISE_SOURCE_URL = 'https://www.data.go.kr/data/15110241/openapi.do';
export const FTC_COMPARE_URL = 'https://franchise.ftc.go.kr/firHope/comparePopup.do';
export const FTC_API_BASE = 'https://apis.data.go.kr/1130000';
export const FTC_API_PAGE_SIZE = 1000;
export const FRANCHISE_DEFAULT_YEAR_COUNT = 3;

export type FtcService = {
  key: 'stores' | 'startupCosts';
  name: string;
  path: string;
  datasetUrl: string;
  fields: readonly string[];
  amountFields: readonly string[];
};

// 응답 필드 구성이 기록과 다르면 적재하지 않는다.
export const FTC_SERVICES: Readonly<Record<FtcService['key'], FtcService>> = {
  stores: {
    key: 'stores',
    name: '브랜드별 가맹점 현황',
    path: 'FftcBrandFrcsStatsService/getBrandFrcsStats',
    datasetUrl: 'https://www.data.go.kr/data/15110241/openapi.do',
    fields: [
      'yr',
      'indutyLclasNm',
      'indutyMlsfcNm',
      'corpNm',
      'brandNm',
      'frcsCnt',
      'newFrcsRgsCnt',
      'ctrtEndCnt',
      'ctrtCncltnCnt',
      'nmChgCnt',
      'avrgSlsAmt',
      'arUnitAvrgSlsAmt',
    ],
    amountFields: [
      'frcsCnt',
      'newFrcsRgsCnt',
      'ctrtEndCnt',
      'ctrtCncltnCnt',
      'nmChgCnt',
      'avrgSlsAmt',
      'arUnitAvrgSlsAmt',
    ],
  },
  startupCosts: {
    key: 'startupCosts',
    name: '브랜드별 창업 금액 현황',
    path: 'FftcBrandFntnStatsService/getBrandFntnStats',
    datasetUrl: 'https://www.data.go.kr/data/15110265/openapi.do',
    fields: [
      'yr',
      'indutyLclasNm',
      'indutyMlsfcNm',
      'corpNm',
      'brandNm',
      'jngBzmnJngAmt',
      'jngBzmnEduAmt',
      'jngBzmnAssrncAmt',
      'jngBzmnEtcAmt',
      'smtnAmt',
    ],
    amountFields: ['jngBzmnJngAmt', 'jngBzmnEduAmt', 'jngBzmnAssrncAmt', 'jngBzmnEtcAmt', 'smtnAmt'],
  },
};

// 공정위 업종 중분류 → 서울시 상위 업종. 제품 범위(한식, 커피·음료)만 적재한다.
export const INDUSTRY_MIDDLE_TO_MARKET: Readonly<Record<string, 'CS100001' | 'CS100010'>> = {
  한식: 'CS100001',
  커피: 'CS100010',
  '음료 (커피 외)': 'CS100010',
};
export const FRANCHISE_INDUSTRY_LARGE = '외식';

export type MarketIndustryCode = 'CS100001' | 'CS100010';

export type FranchiseBrandRecord = {
  disclosureYear: number;
  corpName: string;
  brandName: string;
  industryLarge: string;
  industryMiddle: string;
  marketIndustryCode: MarketIndustryCode;
  storeCount: number;
  newStoreCount: number;
  contractEndCount: number;
  contractCancelCount: number;
  ownershipChangeCount: number;
  averageSalesThousand: string | null;
  averageSalesPerAreaThousand: string | null;
  franchiseFeeThousand: string | null;
  educationFeeThousand: string | null;
  depositThousand: string | null;
  otherCostThousand: string | null;
  startupTotalThousand: string | null;
};

export type FranchiseSourceRecord = {
  service: FtcService['key'];
  name: string;
  year: number;
  totalRows: number;
  scopeRows: number;
  sha256: string;
};

export type FranchiseYearStats = {
  disclosureYear: number;
  performanceYear: number;
  // 가맹점 수·개폐점·평균매출이 모두 0이면 신규 브랜드인지 미기재인지 원본만으로 알 수 없다.
  statusReported: boolean;
  storeCount: number;
  newStoreCount: number;
  contractEndCount: number;
  contractCancelCount: number;
  ownershipChangeCount: number;
  averageSalesWon: string | null;
  averageSalesPerAreaWon: string | null;
  averageMonthlySalesWon: string | null;
  startupCosts: {
    franchiseFeeWon: string | null;
    educationFeeWon: string | null;
    depositWon: string | null;
    otherCostWon: string | null;
    totalWon: string | null;
  } | null;
};

export type FranchiseBrand = {
  id: string;
  brandName: string;
  corpName: string;
  industryMiddle: string;
  latest: FranchiseYearStats;
  history: FranchiseYearStats[];
};

export type FranchisePayload = {
  source: {
    name: string;
    sourceUrl: string;
    compareUrl: string;
    releaseKey: string;
    retrievedAt: string;
    basisYears: string;
    latestDisclosureYear: number;
    latestPerformanceYear: number;
    startupCostsIncluded: boolean;
  };
  industry: { code: MarketIndustryCode; label: string; ftcMiddleNames: string[] };
  summary: { brandCount: number; brandsWithStores: number; brandsWithSales: number };
  query: string;
  brands: FranchiseBrand[];
  totalMatches: number;
  definitions: string[];
  limitations: string[];
};
