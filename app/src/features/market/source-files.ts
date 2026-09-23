import { contentHash } from './checksum.ts';
import { basisPeriodCode, basisPeriodLabel } from './quarter.ts';
import { MARKET_DEFINITION_VERSION, MARKET_SCHEMA_VERSION } from './types.ts';

export type SourceFileRole = 'sales' | 'stores' | 'areas';

export type SourceFileDefinition = {
  file: string;
  role: SourceFileRole;
  datasetId: string;
  datasetName: string;
  url: string;
  basisPeriod: string;
  year: number | null;
  expectedBytes: number;
  expectedSha256: string;
  expectedRowCount: number;
};

export type SourceFileRecord = {
  file: string;
  role: SourceFileRole;
  datasetId: string;
  datasetName: string;
  url: string;
  basisPeriod: string;
  bytes: number;
  sha256: string;
  rowCount: number;
  checksumVerified: boolean;
};

// Basis period of the first F3 release: the eight quarters verified on
// 2026-09-10. A different period needs its own manifest entry, not a rename.
export const MARKET_BASIS_START_QUARTER = '20241';
export const MARKET_BASIS_END_QUARTER = '20254';
export const MARKET_RETRIEVED_AT = '2026-09-09';
export const MARKET_SOURCE_URL = 'https://data.seoul.go.kr/dataList/OA-15572/S/1/datasetView.do';

export const MARKET_RELEASE_LABEL = `서울시 상권분석서비스 ${basisPeriodLabel(MARKET_BASIS_START_QUARTER, MARKET_BASIS_END_QUARTER)}`;

// Expected bytes and SHA-256 recorded in docs/verification/market-verification.json
// for the files downloaded on 2026-09-09.
export const MARKET_SOURCE_FILES: readonly SourceFileDefinition[] = [
  {
    file: 'areas.zip',
    role: 'areas',
    datasetId: 'OA-15560',
    datasetName: '영역-상권',
    url: 'https://data.seoul.go.kr/dataList/OA-15560/S/1/datasetView.do',
    basisPeriod: '2024Q1-2025Q4',
    year: null,
    expectedBytes: 2123078,
    expectedSha256: '38bb8fab4e45a1171af4989cd7fa1275f68e5d644aa770f5431ce7ccc38384dd',
    expectedRowCount: 1650,
  },
  {
    file: 'sales-2024.zip',
    role: 'sales',
    datasetId: 'OA-15572',
    datasetName: '추정매출-상권',
    url: 'https://data.seoul.go.kr/dataList/OA-15572/S/1/datasetView.do',
    basisPeriod: '2024Q1-2024Q4',
    year: 2024,
    expectedBytes: 14288976,
    expectedSha256: '97e7cde3a3291a8fd623f7b5268ea4b01a666027ae20da2ddf804ddae22288c5',
    expectedRowCount: 87179,
  },
  {
    file: 'sales-2025.zip',
    role: 'sales',
    datasetId: 'OA-15572',
    datasetName: '추정매출-상권',
    url: 'https://data.seoul.go.kr/dataList/OA-15572/S/1/datasetView.do',
    basisPeriod: '2025Q1-2025Q4',
    year: 2025,
    expectedBytes: 14035292,
    expectedSha256: 'c907f3d386d62b89f45781e6e6172328ee91b1b8dd2c621e4171e437bee1c6b2',
    expectedRowCount: 85732,
  },
  {
    file: 'stores-2024.zip',
    role: 'stores',
    datasetId: 'OA-15577',
    datasetName: '점포-상권',
    url: 'https://data.seoul.go.kr/dataList/OA-15577/S/1/datasetView.do',
    basisPeriod: '2024Q1-2024Q4',
    year: 2024,
    expectedBytes: 2155369,
    expectedSha256: '969b7c38e5f3cc8630970e4ca8b85ef1c20d485982f64a90de990b13b38ca5ff',
    expectedRowCount: 306889,
  },
  {
    file: 'stores-2025.zip',
    role: 'stores',
    datasetId: 'OA-15577',
    datasetName: '점포-상권',
    url: 'https://data.seoul.go.kr/dataList/OA-15577/S/1/datasetView.do',
    basisPeriod: '2025Q1-2025Q4',
    year: 2025,
    expectedBytes: 2119809,
    expectedSha256: '133bfc6ce79e13ee5b289490e4667dfba46a0af5d0d71df360a0d324e030a4e6',
    expectedRowCount: 304775,
  },
];

// Facts recorded for the same eight-quarter window in the verification report.
export const MARKET_RELEASE_EXPECTATIONS = {
  salesRows: 172911,
  storesRows: 611664,
  areaRows: 1650,
  salesRowsMissingStores: 0,
  duplicateJoinKeys: 0,
  storeOnlyKeys: 438753,
  storeCountIdentityMismatches: 0,
};

// Release identity is the source bytes plus the schema and definition versions,
// so reloading identical files is a no-op and a changed file is a new release.
export function releaseKeyFor(files: readonly { file: string; sha256: string }[]): string {
  const fingerprint = contentHash([
    { file: 'schemaVersion', sha256: MARKET_SCHEMA_VERSION },
    { file: 'definitionVersion', sha256: MARKET_DEFINITION_VERSION },
    { file: 'releaseContent', sha256: contentHash(files) },
  ]);
  return `seoul-market-${basisPeriodCode(MARKET_BASIS_START_QUARTER, MARKET_BASIS_END_QUARTER).toLowerCase()}-${fingerprint.slice(0, 12)}`;
}
