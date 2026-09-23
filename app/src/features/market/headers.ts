import { MarketSourceError } from './validation.ts';

// Column names recorded from the official files downloaded on 2026-09-09.
// 2024 and 2025 sales files share one schema; the store file changed from
// Korean to English column names in 2025, so each year gets its own mapping.
export const SALES_HEADERS: readonly string[] = [
  '기준_년분기_코드',
  '상권_구분_코드',
  '상권_구분_코드_명',
  '상권_코드',
  '상권_코드_명',
  '서비스_업종_코드',
  '서비스_업종_코드_명',
  '당월_매출_금액',
  '당월_매출_건수',
  '주중_매출_금액',
  '주말_매출_금액',
  '월요일_매출_금액',
  '화요일_매출_금액',
  '수요일_매출_금액',
  '목요일_매출_금액',
  '금요일_매출_금액',
  '토요일_매출_금액',
  '일요일_매출_금액',
  '시간대_00~06_매출_금액',
  '시간대_06~11_매출_금액',
  '시간대_11~14_매출_금액',
  '시간대_14~17_매출_금액',
  '시간대_17~21_매출_금액',
  '시간대_21~24_매출_금액',
  '남성_매출_금액',
  '여성_매출_금액',
  '연령대_10_매출_금액',
  '연령대_20_매출_금액',
  '연령대_30_매출_금액',
  '연령대_40_매출_금액',
  '연령대_50_매출_금액',
  '연령대_60_이상_매출_금액',
  '주중_매출_건수',
  '주말_매출_건수',
  '월요일_매출_건수',
  '화요일_매출_건수',
  '수요일_매출_건수',
  '목요일_매출_건수',
  '금요일_매출_건수',
  '토요일_매출_건수',
  '일요일_매출_건수',
  '시간대_건수~06_매출_건수',
  '시간대_건수~11_매출_건수',
  '시간대_건수~14_매출_건수',
  '시간대_건수~17_매출_건수',
  '시간대_건수~21_매출_건수',
  '시간대_건수~24_매출_건수',
  '남성_매출_건수',
  '여성_매출_건수',
  '연령대_10_매출_건수',
  '연령대_20_매출_건수',
  '연령대_30_매출_건수',
  '연령대_40_매출_건수',
  '연령대_50_매출_건수',
  '연령대_60_이상_매출_건수',
];

export const STORES_HEADERS_2024: readonly string[] = [
  '기준_년분기_코드',
  '상권_구분_코드',
  '상권_구분_코드_명',
  '상권_코드',
  '상권_코드_명',
  '서비스_업종_코드',
  '서비스_업종_코드_명',
  '점포_수',
  '유사_업종_점포_수',
  '개업_율',
  '개업_점포_수',
  '폐업_률',
  '폐업_점포_수',
  '프랜차이즈_점포_수',
];

export const STORES_HEADERS_2025: readonly string[] = [
  'stdr_yyqu_cd',
  'trdar_se_cd',
  'trdar_se_cd_nm',
  'trdar_cd',
  'trdar_cd_nm',
  'svc_induty_cd',
  'svc_induty_cd_nm',
  'stor_co',
  'similr_induty_stor_co',
  'opbiz_rt',
  'opbiz_stor_co',
  'clsbiz_rt',
  'clsbiz_stor_co',
  'frc_stor_co',
];

export type CanonicalColumn =
  | 'quarter'
  | 'areaType'
  | 'areaTypeName'
  | 'areaCode'
  | 'areaName'
  | 'industryCode'
  | 'industryName'
  | 'salesAmount'
  | 'salesCount'
  | 'weekdayAmount'
  | 'weekendAmount'
  | 'mondayAmount'
  | 'tuesdayAmount'
  | 'wednesdayAmount'
  | 'thursdayAmount'
  | 'fridayAmount'
  | 'saturdayAmount'
  | 'sundayAmount'
  | 'time0006Amount'
  | 'time0611Amount'
  | 'time1114Amount'
  | 'time1417Amount'
  | 'time1721Amount'
  | 'time2124Amount'
  | 'maleAmount'
  | 'femaleAmount'
  | 'age10Amount'
  | 'age20Amount'
  | 'age30Amount'
  | 'age40Amount'
  | 'age50Amount'
  | 'age60Amount'
  | 'weekdayCount'
  | 'weekendCount'
  | 'mondayCount'
  | 'tuesdayCount'
  | 'wednesdayCount'
  | 'thursdayCount'
  | 'fridayCount'
  | 'saturdayCount'
  | 'sundayCount'
  | 'time0006Count'
  | 'time0611Count'
  | 'time1114Count'
  | 'time1417Count'
  | 'time1721Count'
  | 'time2124Count'
  | 'maleCount'
  | 'femaleCount'
  | 'age10Count'
  | 'age20Count'
  | 'age30Count'
  | 'age40Count'
  | 'age50Count'
  | 'age60Count'
  | 'storeCount'
  | 'similarIndustryStoreCount'
  | 'franchiseStoreCount'
  | 'openedStoreCount'
  | 'closedStoreCount';

export type SourceSchema = {
  id: string;
  label: string;
  expectedHeaders: readonly string[];
  columns: Readonly<Record<string, CanonicalColumn>>;
  requiredColumns: readonly CanonicalColumn[];
};

const SALES_COLUMNS: Readonly<Record<string, CanonicalColumn>> = {
  기준_년분기_코드: 'quarter',
  상권_구분_코드: 'areaType',
  상권_구분_코드_명: 'areaTypeName',
  상권_코드: 'areaCode',
  상권_코드_명: 'areaName',
  서비스_업종_코드: 'industryCode',
  서비스_업종_코드_명: 'industryName',
  당월_매출_금액: 'salesAmount',
  당월_매출_건수: 'salesCount',
  주중_매출_금액: 'weekdayAmount',
  주말_매출_금액: 'weekendAmount',
  월요일_매출_금액: 'mondayAmount',
  화요일_매출_금액: 'tuesdayAmount',
  수요일_매출_금액: 'wednesdayAmount',
  목요일_매출_금액: 'thursdayAmount',
  금요일_매출_금액: 'fridayAmount',
  토요일_매출_금액: 'saturdayAmount',
  일요일_매출_금액: 'sundayAmount',
  '시간대_00~06_매출_금액': 'time0006Amount',
  '시간대_06~11_매출_금액': 'time0611Amount',
  '시간대_11~14_매출_금액': 'time1114Amount',
  '시간대_14~17_매출_금액': 'time1417Amount',
  '시간대_17~21_매출_금액': 'time1721Amount',
  '시간대_21~24_매출_금액': 'time2124Amount',
  남성_매출_금액: 'maleAmount',
  여성_매출_금액: 'femaleAmount',
  연령대_10_매출_금액: 'age10Amount',
  연령대_20_매출_금액: 'age20Amount',
  연령대_30_매출_금액: 'age30Amount',
  연령대_40_매출_금액: 'age40Amount',
  연령대_50_매출_금액: 'age50Amount',
  연령대_60_이상_매출_금액: 'age60Amount',
  주중_매출_건수: 'weekdayCount',
  주말_매출_건수: 'weekendCount',
  월요일_매출_건수: 'mondayCount',
  화요일_매출_건수: 'tuesdayCount',
  수요일_매출_건수: 'wednesdayCount',
  목요일_매출_건수: 'thursdayCount',
  금요일_매출_건수: 'fridayCount',
  토요일_매출_건수: 'saturdayCount',
  일요일_매출_건수: 'sundayCount',
  '시간대_건수~06_매출_건수': 'time0006Count',
  '시간대_건수~11_매출_건수': 'time0611Count',
  '시간대_건수~14_매출_건수': 'time1114Count',
  '시간대_건수~17_매출_건수': 'time1417Count',
  '시간대_건수~21_매출_건수': 'time1721Count',
  '시간대_건수~24_매출_건수': 'time2124Count',
  남성_매출_건수: 'maleCount',
  여성_매출_건수: 'femaleCount',
  연령대_10_매출_건수: 'age10Count',
  연령대_20_매출_건수: 'age20Count',
  연령대_30_매출_건수: 'age30Count',
  연령대_40_매출_건수: 'age40Count',
  연령대_50_매출_건수: 'age50Count',
  연령대_60_이상_매출_건수: 'age60Count',
};

const STORES_COLUMNS_2024: Readonly<Record<string, CanonicalColumn>> = {
  기준_년분기_코드: 'quarter',
  상권_구분_코드: 'areaType',
  상권_구분_코드_명: 'areaTypeName',
  상권_코드: 'areaCode',
  상권_코드_명: 'areaName',
  서비스_업종_코드: 'industryCode',
  서비스_업종_코드_명: 'industryName',
  점포_수: 'storeCount',
  유사_업종_점포_수: 'similarIndustryStoreCount',
  프랜차이즈_점포_수: 'franchiseStoreCount',
  개업_점포_수: 'openedStoreCount',
  폐업_점포_수: 'closedStoreCount',
};

const STORES_COLUMNS_2025: Readonly<Record<string, CanonicalColumn>> = {
  stdr_yyqu_cd: 'quarter',
  trdar_se_cd: 'areaType',
  trdar_se_cd_nm: 'areaTypeName',
  trdar_cd: 'areaCode',
  trdar_cd_nm: 'areaName',
  svc_induty_cd: 'industryCode',
  svc_induty_cd_nm: 'industryName',
  stor_co: 'storeCount',
  similr_induty_stor_co: 'similarIndustryStoreCount',
  frc_stor_co: 'franchiseStoreCount',
  opbiz_stor_co: 'openedStoreCount',
  clsbiz_stor_co: 'closedStoreCount',
};

// Field names of the Seoul Open API services (서울 열린데이터광장). The sales
// service mirrors the sales file column by column; the store service uses the
// 2025 file's English names in upper case. Checked against the live API on 2026-09-23.
export const SALES_API_FIELDS: Readonly<Record<string, CanonicalColumn>> = {
  STDR_YYQU_CD: 'quarter',
  TRDAR_SE_CD: 'areaType',
  TRDAR_SE_CD_NM: 'areaTypeName',
  TRDAR_CD: 'areaCode',
  TRDAR_CD_NM: 'areaName',
  SVC_INDUTY_CD: 'industryCode',
  SVC_INDUTY_CD_NM: 'industryName',
  THSMON_SELNG_AMT: 'salesAmount',
  THSMON_SELNG_CO: 'salesCount',
  MDWK_SELNG_AMT: 'weekdayAmount',
  WKEND_SELNG_AMT: 'weekendAmount',
  MON_SELNG_AMT: 'mondayAmount',
  TUES_SELNG_AMT: 'tuesdayAmount',
  WED_SELNG_AMT: 'wednesdayAmount',
  THUR_SELNG_AMT: 'thursdayAmount',
  FRI_SELNG_AMT: 'fridayAmount',
  SAT_SELNG_AMT: 'saturdayAmount',
  SUN_SELNG_AMT: 'sundayAmount',
  TMZON_00_06_SELNG_AMT: 'time0006Amount',
  TMZON_06_11_SELNG_AMT: 'time0611Amount',
  TMZON_11_14_SELNG_AMT: 'time1114Amount',
  TMZON_14_17_SELNG_AMT: 'time1417Amount',
  TMZON_17_21_SELNG_AMT: 'time1721Amount',
  TMZON_21_24_SELNG_AMT: 'time2124Amount',
  ML_SELNG_AMT: 'maleAmount',
  FML_SELNG_AMT: 'femaleAmount',
  AGRDE_10_SELNG_AMT: 'age10Amount',
  AGRDE_20_SELNG_AMT: 'age20Amount',
  AGRDE_30_SELNG_AMT: 'age30Amount',
  AGRDE_40_SELNG_AMT: 'age40Amount',
  AGRDE_50_SELNG_AMT: 'age50Amount',
  AGRDE_60_ABOVE_SELNG_AMT: 'age60Amount',
  MDWK_SELNG_CO: 'weekdayCount',
  WKEND_SELNG_CO: 'weekendCount',
  MON_SELNG_CO: 'mondayCount',
  TUES_SELNG_CO: 'tuesdayCount',
  WED_SELNG_CO: 'wednesdayCount',
  THUR_SELNG_CO: 'thursdayCount',
  FRI_SELNG_CO: 'fridayCount',
  SAT_SELNG_CO: 'saturdayCount',
  SUN_SELNG_CO: 'sundayCount',
  TMZON_00_06_SELNG_CO: 'time0006Count',
  TMZON_06_11_SELNG_CO: 'time0611Count',
  TMZON_11_14_SELNG_CO: 'time1114Count',
  TMZON_14_17_SELNG_CO: 'time1417Count',
  TMZON_17_21_SELNG_CO: 'time1721Count',
  TMZON_21_24_SELNG_CO: 'time2124Count',
  ML_SELNG_CO: 'maleCount',
  FML_SELNG_CO: 'femaleCount',
  AGRDE_10_SELNG_CO: 'age10Count',
  AGRDE_20_SELNG_CO: 'age20Count',
  AGRDE_30_SELNG_CO: 'age30Count',
  AGRDE_40_SELNG_CO: 'age40Count',
  AGRDE_50_SELNG_CO: 'age50Count',
  AGRDE_60_ABOVE_SELNG_CO: 'age60Count',
};

export const STORES_API_FIELDS: Readonly<Record<string, CanonicalColumn | null>> = {
  STDR_YYQU_CD: 'quarter',
  TRDAR_SE_CD: 'areaType',
  TRDAR_SE_CD_NM: 'areaTypeName',
  TRDAR_CD: 'areaCode',
  TRDAR_CD_NM: 'areaName',
  SVC_INDUTY_CD: 'industryCode',
  SVC_INDUTY_CD_NM: 'industryName',
  SIMILR_INDUTY_STOR_CO: 'similarIndustryStoreCount',
  STOR_CO: 'storeCount',
  FRC_STOR_CO: 'franchiseStoreCount',
  OPBIZ_RT: null,
  OPBIZ_STOR_CO: 'openedStoreCount',
  CLSBIZ_RT: null,
  CLSBIZ_STOR_CO: 'closedStoreCount',
};

// Area service fields that the area record uses; the service also returns the
// centroid, administrative dong and area size, which are kept only in the hash.
export const AREA_API_FIELDS = {
  areaType: 'TRDAR_SE_CD',
  areaTypeName: 'TRDAR_SE_CD_NM',
  areaCode: 'TRDAR_CD',
  sourceName: 'TRDAR_CD_NM',
  districtCode: 'SIGNGU_CD',
  districtName: 'SIGNGU_CD_NM',
} as const;

export const AREA_API_FIELD_NAMES: readonly string[] = [
  'TRDAR_SE_CD',
  'TRDAR_SE_CD_NM',
  'TRDAR_CD',
  'TRDAR_CD_NM',
  'XCNTS_VALUE',
  'YDNTS_VALUE',
  'SIGNGU_CD',
  'SIGNGU_CD_NM',
  'ADSTRD_CD',
  'ADSTRD_CD_NM',
  'RELM_AR',
];

const KEY_COLUMNS: readonly CanonicalColumn[] = ['quarter', 'areaType', 'areaCode', 'industryCode'];

export const SALES_SCHEMA_2024: SourceSchema = {
  id: 'sales-2024',
  label: '추정매출-상권 2024년',
  expectedHeaders: SALES_HEADERS,
  columns: SALES_COLUMNS,
  requiredColumns: [...KEY_COLUMNS, 'salesAmount', 'salesCount'],
};

export const SALES_SCHEMA_2025: SourceSchema = {
  id: 'sales-2025',
  label: '추정매출-상권 2025년',
  expectedHeaders: SALES_HEADERS,
  columns: SALES_COLUMNS,
  requiredColumns: [...KEY_COLUMNS, 'salesAmount', 'salesCount'],
};

export const STORES_SCHEMA_2024: SourceSchema = {
  id: 'stores-2024',
  label: '점포-상권 2024년',
  expectedHeaders: STORES_HEADERS_2024,
  columns: STORES_COLUMNS_2024,
  requiredColumns: [
    ...KEY_COLUMNS,
    'storeCount',
    'similarIndustryStoreCount',
    'franchiseStoreCount',
    'openedStoreCount',
    'closedStoreCount',
  ],
};

export const STORES_SCHEMA_2025: SourceSchema = {
  id: 'stores-2025',
  label: '점포-상권 2025년',
  expectedHeaders: STORES_HEADERS_2025,
  columns: STORES_COLUMNS_2025,
  requiredColumns: [
    ...KEY_COLUMNS,
    'storeCount',
    'similarIndustryStoreCount',
    'franchiseStoreCount',
    'openedStoreCount',
    'closedStoreCount',
  ],
};

export type ColumnIndex = Partial<Record<CanonicalColumn, number>>;

export function requireColumn(index: ColumnIndex, column: CanonicalColumn): number {
  const position = index[column];
  if (position === undefined) {
    throw new MarketSourceError('UNEXPECTED_HEADER', `열 '${column}'의 원본 열 위치를 찾지 못했습니다.`);
  }
  return position;
}

// Rejects a file whose headers are not the recorded ones, then resolves the
// canonical name to a column position by name rather than by ordinal.
export function resolveColumnIndex(schema: SourceSchema, actualHeaders: readonly string[]): ColumnIndex {
  const expected = new Set(schema.expectedHeaders);
  const seen = new Set<string>();
  for (const header of actualHeaders) {
    if (seen.has(header)) {
      throw new MarketSourceError('UNEXPECTED_HEADER', `${schema.label}: 열 이름 '${header}'이(가) 중복됩니다.`);
    }
    seen.add(header);
  }
  const missing = schema.expectedHeaders.filter((header) => !seen.has(header));
  const unexpected = actualHeaders.filter((header) => !expected.has(header));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new MarketSourceError(
      'UNEXPECTED_HEADER',
      `${schema.label}: 예상한 열 구성과 다릅니다. 누락 ${missing.length}개[${missing.slice(0, 5).join(', ')}], 예상 밖 ${unexpected.length}개[${unexpected.slice(0, 5).join(', ')}]`,
    );
  }
  const index = {} as ColumnIndex;
  for (const [header, column] of Object.entries(schema.columns)) {
    const position = actualHeaders.indexOf(header);
    if (position < 0) {
      throw new MarketSourceError('UNEXPECTED_HEADER', `${schema.label}: 열 '${header}'을(를) 찾지 못했습니다.`);
    }
    index[column] = position;
  }
  for (const column of schema.requiredColumns) {
    if (index[column] === undefined) {
      throw new MarketSourceError(
        'UNEXPECTED_HEADER',
        `${schema.label}: 필수 열 '${column}'의 원본 열 이름이 매핑에 없습니다.`,
      );
    }
  }
  return index;
}
