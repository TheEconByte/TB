// 한국부동산원 상업용부동산 임대동향조사(국가승인통계 408001). 운영자 적재 명령에서만
// R-ONE Open API를 호출하고, 웹 요청 중에는 적재된 스냅샷만 읽는다.
export const RENT_BENCHMARK_SCHEMA_VERSION = 'reb-rent-benchmark-v1.0.0';
export const RENT_BENCHMARK_STAT_NAME = '한국부동산원 상업용부동산 임대동향조사';
export const RENT_BENCHMARK_SOURCE_URL =
  'https://www.reb.or.kr/reb/cm/cntnts/cntntsView.do?mi=10335&cntntsId=1049&statId=S237220284';
export const REB_API_BASE = 'https://www.reb.or.kr/r-one/openapi';
export const REB_API_PAGE_SIZE = 1000;

export const BUILDING_TYPES = ['SMALL_RETAIL', 'MEDIUM_LARGE_RETAIL', 'COLLECTIVE_RETAIL'] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];

export const BUILDING_TYPE_LABELS: Readonly<Record<BuildingType, string>> = {
  SMALL_RETAIL: '소규모 상가',
  MEDIUM_LARGE_RETAIL: '중대형 상가',
  COLLECTIVE_RETAIL: '집합 상가',
};

// 부동산원의 상가 유형 구분 기준.
export const BUILDING_TYPE_CRITERIA: Readonly<Record<BuildingType, string>> = {
  SMALL_RETAIL: '2층 이하, 연면적 330㎡ 이하',
  MEDIUM_LARGE_RETAIL: '3층 이상 또는 연면적 330㎡ 초과',
  COLLECTIVE_RETAIL: '호별로 구분 소유하는 집합건물',
};

// RENT: 지역별 임대료(1층 기준 대표값), FLOOR_RENT: 층별 임대료, VACANCY_RATE: 공실률.
export type RentMetric = 'RENT' | 'FLOOR_RENT' | 'VACANCY_RATE';

// 층과 무관한 지역별 표는 NONE으로 저장한다.
export const FLOOR_CODES = ['NONE', 'B1', '1F', '2F', '3F', '4F', '5F', '6F_PLUS'] as const;
export type FloorCode = (typeof FLOOR_CODES)[number];

export const SOURCE_FLOOR_NAMES: Readonly<Record<string, FloorCode>> = {
  지하1층: 'B1',
  '1층': '1F',
  '2층': '2F',
  '3층': '3F',
  '4층': '4F',
  '5층': '5F',
  '6층이상': '6F_PLUS',
};

export const FLOOR_LABELS: Readonly<Record<FloorCode, string>> = {
  NONE: '대표값',
  B1: '지하 1층',
  '1F': '1층',
  '2F': '2층',
  '3F': '3층',
  '4F': '4층',
  '5F': '5층',
  '6F_PLUS': '6층 이상',
};

export type RebTable = {
  id: string;
  name: string;
  buildingType: BuildingType;
  metric: RentMetric;
  item: string;
  unit: string;
};

// 2024년 3분기에 조사 체계가 바뀐 뒤의 표만 쓴다. 이름은 적재 때 표 목록과 대조해
// 같은 ID가 다른 표를 가리키면 적재하지 않는다.
export const REB_RENT_TABLES: readonly RebTable[] = [
  {
    id: 'T248223134698125',
    name: '임대동향 지역별 임대료(2024년3분기~)_소규모 상가',
    buildingType: 'SMALL_RETAIL',
    metric: 'RENT',
    item: '임대료',
    unit: '천원/㎡',
  },
  {
    id: 'T244363134858603',
    name: '임대동향 지역별 임대료(2024년3분기~)_중대형 상가',
    buildingType: 'MEDIUM_LARGE_RETAIL',
    metric: 'RENT',
    item: '임대료',
    unit: '천원/㎡',
  },
  {
    id: 'T244913134948657',
    name: '임대동향 지역별 임대료(2024년3분기~)_집합 상가',
    buildingType: 'COLLECTIVE_RETAIL',
    metric: 'RENT',
    item: '임대료',
    unit: '천원/㎡',
  },
  {
    id: 'T246233134891629',
    name: '임대동향 층별임대료 및 층별효용비율(2024년3분기~)_소규모 상가',
    buildingType: 'SMALL_RETAIL',
    metric: 'FLOOR_RENT',
    item: '임대료',
    unit: '천원/㎡',
  },
  {
    id: 'T241873134863890',
    name: '임대동향 층별임대료 및 층별효용비율(2024년3분기~)_중대형 상가',
    buildingType: 'MEDIUM_LARGE_RETAIL',
    metric: 'FLOOR_RENT',
    item: '임대료',
    unit: '천원/㎡',
  },
  {
    id: 'T249023134703697',
    name: '임대동향 층별임대료 및 층별효용비율(2024년3분기~)_집합 상가',
    buildingType: 'COLLECTIVE_RETAIL',
    metric: 'FLOOR_RENT',
    item: '임대료',
    unit: '천원/㎡',
  },
  {
    id: 'T241833134686576',
    name: '임대동향 지역별 공실률(2024년3분기~)_소규모 상가',
    buildingType: 'SMALL_RETAIL',
    metric: 'VACANCY_RATE',
    item: '공실률',
    unit: '%',
  },
  {
    id: 'T249633134845544',
    name: '임대동향 지역별 공실률(2024년3분기~)_중대형 상가',
    buildingType: 'MEDIUM_LARGE_RETAIL',
    metric: 'VACANCY_RATE',
    item: '공실률',
    unit: '%',
  },
  {
    id: 'T243283134931290',
    name: '임대동향 지역별 공실률(2024년3분기~)_집합 상가',
    buildingType: 'COLLECTIVE_RETAIL',
    metric: 'VACANCY_RATE',
    item: '공실률',
    unit: '%',
  },
];

// 층별 표는 임대료와 층별효용비율을 함께 준다. 효용비율은 쓰지 않지만 알려진 항목이다.
export const IGNORED_FLOOR_ITEMS: ReadonlySet<string> = new Set(['효용비율']);

export type RentObservationRecord = {
  buildingType: BuildingType;
  metric: RentMetric;
  quarter: string;
  regionPath: string;
  regionName: string;
  regionLevel: number;
  floor: FloorCode;
  value: string | null;
  unit: string;
  sourceTableId: string;
};

export type RentSourceTableRecord = {
  id: string;
  name: string;
  buildingType: BuildingType;
  metric: RentMetric;
  totalRows: number;
  seoulRows: number;
  sha256: string;
};

export type RentFloorValue = {
  floor: FloorCode;
  label: string;
  rentPerSquareMeterWon: string | null;
  sourceValue: string | null;
};

export type RentRegionBenchmark = {
  path: string;
  name: string;
  level: number;
  groupName: string | null;
  districtCodes: string[];
  latest: {
    rentPerSquareMeterWon: string | null;
    sourceValue: string | null;
    vacancyRatePercent: string | null;
    floors: RentFloorValue[];
  };
  trend: Array<{ quarter: string; label: string; rentPerSquareMeterWon: string | null }>;
};

export type RentBenchmarkPayload = {
  source: {
    statName: string;
    sourceUrl: string;
    releaseKey: string;
    retrievedAt: string;
    basisPeriodLabel: string;
    latestQuarter: string;
    latestQuarterLabel: string;
    sourceUnit: string;
  };
  buildingType: { code: BuildingType; label: string; criteria: string };
  district: { code: string; name: string; regionPaths: string[] } | null;
  regionMappingVersion: string;
  regions: RentRegionBenchmark[];
  definitions: string[];
  limitations: string[];
};
