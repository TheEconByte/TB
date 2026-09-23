import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from './checksum.ts';
import { decodeCp949, iterateCsvRows, normalizeHeaderRow } from './csv.ts';
import { parseDbf } from './dbf.ts';
import {
  resolveColumnIndex,
  SALES_SCHEMA_2024,
  SALES_SCHEMA_2025,
  STORES_SCHEMA_2024,
  STORES_SCHEMA_2025,
  type CanonicalColumn,
  type ColumnIndex,
  type SourceSchema,
} from './headers.ts';
import { quarterLabel } from './quarter.ts';
import {
  MARKET_BASIS_END_QUARTER,
  MARKET_BASIS_START_QUARTER,
  MARKET_RELEASE_EXPECTATIONS,
  MARKET_RELEASE_LABEL,
  MARKET_RETRIEVED_AT,
  MARKET_SOURCE_FILES,
  MARKET_SOURCE_URL,
  releaseKeyFor,
  type SourceFileDefinition,
  type SourceFileRecord,
  type SourceFileRole,
} from './source-files.ts';
import {
  AREA_TYPES,
  INDUSTRY_CATEGORY_VERSION,
  MARKET_DEFINITION_VERSION,
  MARKET_SCHEMA_VERSION,
  SUPPORTED_INDUSTRIES,
  supportedIndustry,
  type SalesBreakdown,
  type DisplayNameSource,
} from './types.ts';
import {
  createIssueCollector,
  isAreaCode,
  isDistrictCode,
  isIndustryCode,
  isQuarterCode,
  MarketSourceError,
  parseAmountCell,
  parseCountCell,
  type IssueCollector,
  type MarketIssue,
} from './validation.ts';
import { findEntry, readCentralDirectory, readEntry, type ZipEntry } from './zip.ts';

export type MarketAreaRecord = {
  areaType: string;
  areaCode: string;
  sourceName: string;
  observedName: string | null;
  areaTypeName: string;
  districtCode: string;
  districtName: string;
};

export type MarketIndustryRecord = {
  code: string;
  sourceName: string;
  displayName: string;
  displayNameSource: DisplayNameSource;
  sourceCategoryVersion: string;
  isSupported: boolean;
};

export type MarketQuarterlyRecord = {
  quarter: string;
  areaType: string;
  areaCode: string;
  industryCode: string;
  salesAmount: string | null;
  salesCount: string | null;
  salesBreakdownJson: SalesBreakdown | null;
  storeCount: number | null;
  similarIndustryStoreCount: number | null;
  franchiseStoreCount: number | null;
  openedStoreCount: number | null;
  closedStoreCount: number | null;
};

export type MarketCheck = { name: string; expected: string; actual: string; passed: boolean };

export type ParsedMarketSources = {
  releaseKey: string;
  releaseLabel: string;
  files: SourceFileRecord[];
  checksumVerified: boolean;
  areas: MarketAreaRecord[];
  industries: MarketIndustryRecord[];
  quarterly: MarketQuarterlyRecord[];
  stats: {
    salesRows: number;
    storeRows: number;
    areaRows: number;
    salesRowsMissingStores: number;
    storeOnlyKeys: number;
    duplicateKeys: number;
    storeCountIdentityMismatches: number;
    areaNameMismatches: number;
    salesRowsForSupportedIndustries: number;
    storeOnlyQuarterlyRows: number;
    quarters: string[];
  };
  checks: MarketCheck[];
  warnings: MarketIssue[];
};

const SEPARATOR = '|';
const AREA_TYPE_SET = new Set<string>(AREA_TYPES);

const AREA_DBF_FIELDS = {
  areaType: 'TRDAR_SE_C',
  areaTypeName: 'TRDAR_SE_1',
  areaCode: 'TRDAR_CD',
  sourceName: 'TRDAR_CD_N',
  districtCode: 'SIGNGU_CD',
  districtName: 'SIGNGU_CD_',
} as const;

function areaKey(areaType: string, areaCode: string): string {
  return `${areaType}${SEPARATOR}${areaCode}`;
}

type JoinKey = { quarter: string; areaType: string; areaCode: string; industryCode: string };

function joinKey(parts: JoinKey): string {
  return [parts.quarter, parts.areaType, parts.areaCode, parts.industryCode].join(SEPARATOR);
}

function splitJoinKey(key: string): JoinKey {
  const [quarter = '', areaType = '', areaCode = '', industryCode = ''] = key.split(SEPARATOR);
  return { quarter, areaType, areaCode, industryCode };
}

type StoreCounts = {
  storeCount: number;
  similarIndustryStoreCount: number;
  franchiseStoreCount: number;
  openedStoreCount: number;
  closedStoreCount: number;
};

type SalesObservation = {
  salesAmount: string;
  salesCount: string | null;
  salesBreakdownJson: SalesBreakdown | null;
};

type BreakdownSpec = {
  key: string;
  label: string;
  amount: CanonicalColumn;
  count: CanonicalColumn;
};

const BREAKDOWN_GROUPS: ReadonlyArray<
  Readonly<{
    field: keyof Pick<SalesBreakdown, 'dayOfWeek' | 'timeOfDay' | 'gender' | 'age'>;
    points: readonly BreakdownSpec[];
  }>
> = [
  {
    field: 'dayOfWeek',
    points: [
      { key: 'MON', label: '월', amount: 'mondayAmount', count: 'mondayCount' },
      { key: 'TUE', label: '화', amount: 'tuesdayAmount', count: 'tuesdayCount' },
      { key: 'WED', label: '수', amount: 'wednesdayAmount', count: 'wednesdayCount' },
      { key: 'THU', label: '목', amount: 'thursdayAmount', count: 'thursdayCount' },
      { key: 'FRI', label: '금', amount: 'fridayAmount', count: 'fridayCount' },
      { key: 'SAT', label: '토', amount: 'saturdayAmount', count: 'saturdayCount' },
      { key: 'SUN', label: '일', amount: 'sundayAmount', count: 'sundayCount' },
    ],
  },
  {
    field: 'timeOfDay',
    points: [
      { key: '00_06', label: '00~06시', amount: 'time0006Amount', count: 'time0006Count' },
      { key: '06_11', label: '06~11시', amount: 'time0611Amount', count: 'time0611Count' },
      { key: '11_14', label: '11~14시', amount: 'time1114Amount', count: 'time1114Count' },
      { key: '14_17', label: '14~17시', amount: 'time1417Amount', count: 'time1417Count' },
      { key: '17_21', label: '17~21시', amount: 'time1721Amount', count: 'time1721Count' },
      { key: '21_24', label: '21~24시', amount: 'time2124Amount', count: 'time2124Count' },
    ],
  },
  {
    field: 'gender',
    points: [
      { key: 'MALE', label: '남성', amount: 'maleAmount', count: 'maleCount' },
      { key: 'FEMALE', label: '여성', amount: 'femaleAmount', count: 'femaleCount' },
    ],
  },
  {
    field: 'age',
    points: [
      { key: '10', label: '10대', amount: 'age10Amount', count: 'age10Count' },
      { key: '20', label: '20대', amount: 'age20Amount', count: 'age20Count' },
      { key: '30', label: '30대', amount: 'age30Amount', count: 'age30Count' },
      { key: '40', label: '40대', amount: 'age40Amount', count: 'age40Count' },
      { key: '50', label: '50대', amount: 'age50Amount', count: 'age50Count' },
      { key: '60_PLUS', label: '60대 이상', amount: 'age60Amount', count: 'age60Count' },
    ],
  },
];

function decodeZipEntryName(raw: Buffer): string {
  return decodeCp949(raw, 'ZIP 항목 이름');
}

function readSourceFile(
  sourceDir: string,
  definition: SourceFileDefinition,
  issues: IssueCollector,
  acceptChangedSource: boolean,
): { buffer: Buffer; record: SourceFileRecord } {
  let buffer: Buffer;
  try {
    buffer = readFileSync(join(sourceDir, definition.file));
  } catch {
    throw new MarketSourceError(
      'SOURCE_FILE_MISSING',
      `원본 파일을 읽지 못했습니다: ${join(sourceDir, definition.file)}. docs/verification/README.md의 원본 준비 절차를 확인해 주세요.`,
    );
  }
  const bytes = buffer.length;
  const sha256 = sha256Hex(buffer);
  const bytesMatch = bytes === definition.expectedBytes;
  const checksumMatch = sha256 === definition.expectedSha256;
  if (!checksumMatch || !bytesMatch) {
    const detail = `${definition.file}: 기록된 원본과 다릅니다. bytes ${definition.expectedBytes}→${bytes}, sha256 ${definition.expectedSha256.slice(0, 16)}…→${sha256.slice(0, 16)}…`;
    if (acceptChangedSource) issues.warn('CHECKSUM_MISMATCH', definition.file, detail);
    else {
      issues.add('CHECKSUM_MISMATCH', definition.file, detail);
      if (!bytesMatch)
        issues.add('BYTE_SIZE_MISMATCH', definition.file, `${definition.file}: 파일 크기가 기록과 다릅니다.`);
    }
  }
  return {
    buffer,
    record: {
      file: definition.file,
      role: definition.role,
      datasetId: definition.datasetId,
      datasetName: definition.datasetName,
      url: definition.url,
      basisPeriod: definition.basisPeriod,
      bytes,
      sha256,
      rowCount: 0,
      checksumVerified: checksumMatch && bytesMatch,
    },
  };
}

type ZipAccess = {
  optional(extension: string): { entry: ZipEntry; data: Buffer } | null;
  require(extension: string): { entry: ZipEntry; data: Buffer };
};

function openZip(buffer: Buffer): ZipAccess {
  const entries = readCentralDirectory(buffer, decodeZipEntryName);
  return {
    optional(extension) {
      const matches = entries.filter((entry) => entry.name.toLowerCase().endsWith(extension.toLowerCase()));
      if (matches.length === 0) return null;
      return { entry: matches[0], data: readEntry(buffer, matches[0]) };
    },
    require(extension) {
      const entry = findEntry(entries, extension);
      return { entry, data: readEntry(buffer, entry) };
    },
  };
}

function parseAreas(
  sourceDir: string,
  definition: SourceFileDefinition,
  issues: IssueCollector,
  acceptChangedSource: boolean,
): { areas: MarketAreaRecord[]; record: SourceFileRecord } {
  const { buffer, record } = readSourceFile(sourceDir, definition, issues, acceptChangedSource);
  const zip = openZip(buffer);
  const codePage = zip.optional('.cpg');
  if (codePage) {
    const declared = codePage.data.toString('latin1').trim();
    if (!/^utf-?8$/i.test(declared)) {
      issues.add('UNEXPECTED_ENCODING', definition.file, `.cpg가 UTF-8을 선언하지 않습니다: ${declared}`);
    }
  } else {
    issues.warn('UNEXPECTED_ENCODING', definition.file, '.cpg가 없어 속성 인코딩을 UTF-8로 가정합니다.');
  }
  const table = parseDbf(zip.require('.dbf').data);
  const fieldNames = new Set(table.fields.map((field) => field.name));
  for (const field of Object.values(AREA_DBF_FIELDS)) {
    if (!fieldNames.has(field)) issues.add('UNEXPECTED_HEADER', definition.file, `DBF에 ${field} 속성이 없습니다.`);
  }
  issues.throwIfFailed();

  const areas: MarketAreaRecord[] = [];
  const seen = new Set<string>();
  table.rows.forEach((row, index) => {
    const line = index + 1;
    const areaType = (row[AREA_DBF_FIELDS.areaType] ?? '').trim();
    const areaCode = (row[AREA_DBF_FIELDS.areaCode] ?? '').trim();
    const sourceName = (row[AREA_DBF_FIELDS.sourceName] ?? '').trim();
    const areaTypeName = (row[AREA_DBF_FIELDS.areaTypeName] ?? '').trim();
    const districtCode = (row[AREA_DBF_FIELDS.districtCode] ?? '').trim();
    const districtName = (row[AREA_DBF_FIELDS.districtName] ?? '').trim();
    let valid = true;
    if (!AREA_TYPE_SET.has(areaType)) {
      issues.add('INVALID_AREA_TYPE', definition.file, `상권 구분 코드 '${areaType}'`, line);
      valid = false;
    }
    if (!isAreaCode(areaCode)) {
      issues.add('INVALID_AREA_CODE', definition.file, `상권 코드 '${areaCode}'`, line);
      valid = false;
    }
    if (!isDistrictCode(districtCode)) {
      issues.add(
        'MISSING_KEY',
        definition.file,
        `자치구 코드 '${districtCode}' 형식이 올바르지 않습니다. (${areaCode})`,
        line,
      );
      valid = false;
    }
    if (sourceName.length === 0 || areaTypeName.length === 0 || districtName.length === 0) {
      issues.add(
        'MISSING_KEY',
        definition.file,
        `상권 명칭·구분 명칭·자치구 명칭이 비어 있습니다. (${areaCode})`,
        line,
      );
      valid = false;
    }
    const key = areaKey(areaType, areaCode);
    if (seen.has(key)) {
      issues.add('DUPLICATE_AREA', definition.file, `상권 구분/코드 ${key}`, line);
      valid = false;
    }
    seen.add(key);
    if (!valid) return;
    areas.push({ areaType, areaCode, sourceName, observedName: null, areaTypeName, districtCode, districtName });
  });
  record.rowCount = table.rows.length;
  return { areas, record };
}

function parseTabularSource(
  sourceDir: string,
  definition: SourceFileDefinition,
  schema: SourceSchema,
  issues: IssueCollector,
  acceptChangedSource: boolean,
  handle: (get: (column: CanonicalColumn) => string, line: number) => void,
): SourceFileRecord {
  const { buffer, record } = readSourceFile(sourceDir, definition, issues, acceptChangedSource);
  const csvData = openZip(buffer).require('.csv').data;
  const iterator = iterateCsvRows(decodeCp949(csvData, definition.file));
  const header = iterator.next();
  if (header.done) throw new MarketSourceError('UNEXPECTED_HEADER', `${schema.label}: 헤더 행이 없습니다.`);
  const index: ColumnIndex = resolveColumnIndex(schema, normalizeHeaderRow(header.value));
  let line = 1;
  for (const row of iterator) {
    line += 1;
    if (row.length !== schema.expectedHeaders.length) {
      issues.add(
        'UNEXPECTED_ROW_LENGTH',
        definition.file,
        `${line}행의 열이 ${row.length}개입니다. 예상 ${schema.expectedHeaders.length}개`,
        line,
      );
      continue;
    }
    const get = (column: CanonicalColumn) => {
      const position = index[column];
      return position === undefined ? '' : (row[position] ?? '');
    };
    handle(get, line);
  }
  record.rowCount = line - 1;
  return record;
}

function readStoreCounts(
  get: (column: CanonicalColumn) => string,
  file: string,
  line: number,
  issues: IssueCollector,
): StoreCounts | null {
  const columns: [keyof StoreCounts, CanonicalColumn][] = [
    ['storeCount', 'storeCount'],
    ['similarIndustryStoreCount', 'similarIndustryStoreCount'],
    ['franchiseStoreCount', 'franchiseStoreCount'],
    ['openedStoreCount', 'openedStoreCount'],
    ['closedStoreCount', 'closedStoreCount'],
  ];
  const counts = {} as StoreCounts;
  for (const [field, column] of columns) {
    const cell = get(column);
    const parsed = parseCountCell(cell);
    if (!parsed.ok) {
      issues.add(parsed.reason, file, `${column} 값 '${cell}'`, line);
      return null;
    }
    counts[field] = parsed.count;
  }
  return counts;
}

function readSalesObservation(
  get: (column: CanonicalColumn) => string,
  file: string,
  line: number,
  issues: IssueCollector,
): SalesObservation | null {
  const amountCell = get('salesAmount');
  const amount = parseAmountCell(amountCell);
  if (!amount.ok) {
    issues.add(amount.reason, file, `매출 금액 '${amountCell}'`, line);
    return null;
  }

  const salesCountCell = get('salesCount');
  const hasBreakdown = BREAKDOWN_GROUPS.some((group) =>
    group.points.some((point) => get(point.amount).trim() !== '' || get(point.count).trim() !== ''),
  );
  // Synthetic/legacy fixtures may only contain the total amount. Official files
  // contain the full fixed header and values; partial breakdown rows are rejected.
  if (salesCountCell.trim() === '' && !hasBreakdown) {
    return { salesAmount: amount.amount, salesCount: null, salesBreakdownJson: null };
  }
  const salesCount = parseAmountCell(salesCountCell);
  if (!salesCount.ok) {
    issues.add(salesCount.reason, file, `매출 건수 '${salesCountCell}'`, line);
    return null;
  }

  const parsedGroups = {} as Pick<SalesBreakdown, 'dayOfWeek' | 'timeOfDay' | 'gender' | 'age'>;
  for (const group of BREAKDOWN_GROUPS) {
    const points = [];
    for (const point of group.points) {
      const pointAmountCell = get(point.amount);
      const pointCountCell = get(point.count);
      const pointAmount = parseAmountCell(pointAmountCell);
      const pointCount = parseAmountCell(pointCountCell);
      if (!pointAmount.ok || !pointCount.ok) {
        issues.add(
          !pointAmount.ok ? pointAmount.reason : pointCount.ok ? 'NON_NUMERIC_AMOUNT' : pointCount.reason,
          file,
          `${point.label} 세부 매출 금액/건수 '${pointAmountCell}'/'${pointCountCell}'`,
          line,
        );
        return null;
      }
      points.push({
        key: point.key,
        label: point.label,
        salesAmount: pointAmount.amount,
        salesCount: pointCount.amount,
      });
    }
    parsedGroups[group.field] = points;
  }

  return {
    salesAmount: amount.amount,
    salesCount: salesCount.amount,
    salesBreakdownJson: {
      schemaVersion: 'market-sales-breakdown-v1.0.0',
      ...parsedGroups,
      limitations: [
        '서울시 상권분석서비스(추정매출-상권)의 상위 업종 기준 관측값입니다.',
        '성별·연령별 합계에는 성별·연령이 없는 결제가 포함되지 않아 전체와 다를 수 있습니다.',
        '매출 건수는 방문자 수나 주문자 수가 아닙니다.',
      ],
    },
  };
}

export function readMarketSources(
  options: Readonly<{ sourceDir: string; acceptChangedSource?: boolean; log?: (message: string) => void }>,
): ParsedMarketSources {
  const issues = createIssueCollector();
  const log = options.log ?? (() => {});
  const acceptChangedSource = options.acceptChangedSource ?? false;
  const byRole = (role: SourceFileRole) => MARKET_SOURCE_FILES.filter((definition) => definition.role === role);
  const files: SourceFileRecord[] = [];

  log('영역 속성(DBF)을 읽습니다.');
  const areaDefinition = byRole('areas')[0];
  const areaResult = parseAreas(options.sourceDir, areaDefinition, issues, acceptChangedSource);
  files.push(areaResult.record);
  issues.throwIfFailed();

  const areas = areaResult.areas;
  const areaByKey = new Map<string, MarketAreaRecord>();
  const areaTypesByCode = new Map<string, string[]>();
  for (const area of areas) {
    areaByKey.set(areaKey(area.areaType, area.areaCode), area);
    const types = areaTypesByCode.get(area.areaCode) ?? [];
    types.push(area.areaType);
    areaTypesByCode.set(area.areaCode, types);
  }
  for (const [code, types] of areaTypesByCode) {
    if (types.length > 1) {
      issues.warn(
        'AMBIGUOUS_AREA_CODE',
        areaDefinition.file,
        `상권 코드 ${code}가 상권 구분 ${types.join(', ')}에 함께 있습니다.`,
      );
    }
  }

  const salesKeys = new Set<string>();
  const salesObservations = new Map<string, SalesObservation>();
  const storeKeys = new Set<string>();
  const storeCounts = new Map<string, StoreCounts>();
  const observedAreaNames = new Map<string, Set<string>>();
  const industryNames = new Map<string, Map<string, number>>();
  const industryNewest = new Map<string, { name: string; year: number }>();
  const quarters = new Set<string>();
  let salesRows = 0;
  let storeRows = 0;
  let duplicateKeys = 0;
  let storeCountIdentityMismatches = 0;

  const rememberAreaName = (areaType: string, areaCode: string, name: string) => {
    const key = areaKey(areaType, areaCode);
    const names = observedAreaNames.get(key) ?? new Set<string>();
    names.add(name);
    observedAreaNames.set(key, names);
  };
  const rememberIndustry = (code: string, name: string, year: number | null) => {
    const names = industryNames.get(code) ?? new Map<string, number>();
    names.set(name, (names.get(name) ?? 0) + 1);
    industryNames.set(code, names);
    if (name.length > 0) {
      const newest = industryNewest.get(code);
      if (!newest || (year ?? 0) >= newest.year) industryNewest.set(code, { name, year: year ?? 0 });
    }
  };
  const validatedKey = (get: (column: CanonicalColumn) => string, file: string, line: number): JoinKey | null => {
    const parts: JoinKey = {
      quarter: get('quarter').trim(),
      areaType: get('areaType').trim(),
      areaCode: get('areaCode').trim(),
      industryCode: get('industryCode').trim(),
    };
    let valid = true;
    if (!isQuarterCode(parts.quarter)) {
      issues.add('INVALID_QUARTER', file, `기준 분기 '${parts.quarter}'`, line);
      valid = false;
    }
    if (!AREA_TYPE_SET.has(parts.areaType)) {
      issues.add('INVALID_AREA_TYPE', file, `상권 구분 '${parts.areaType}'`, line);
      valid = false;
    }
    if (!isAreaCode(parts.areaCode)) {
      issues.add('INVALID_AREA_CODE', file, `상권 코드 '${parts.areaCode}'`, line);
      valid = false;
    }
    if (!isIndustryCode(parts.industryCode)) {
      issues.add('INVALID_INDUSTRY_CODE', file, `업종 코드 '${parts.industryCode}'`, line);
      valid = false;
    }
    if (!valid) return null;
    if (!areaByKey.has(areaKey(parts.areaType, parts.areaCode))) {
      issues.add('UNKNOWN_AREA', file, `영역 자료에 없는 상권 ${parts.areaType}/${parts.areaCode}`, line);
      return null;
    }
    return parts;
  };

  for (const definition of byRole('sales')) {
    log(`추정매출 ${definition.year}년 파일을 읽습니다.`);
    const schema = definition.year === 2024 ? SALES_SCHEMA_2024 : SALES_SCHEMA_2025;
    const record = parseTabularSource(
      options.sourceDir,
      definition,
      schema,
      issues,
      acceptChangedSource,
      (get, line) => {
        salesRows += 1;
        const parts = validatedKey(get, definition.file, line);
        if (!parts) return;
        const key = joinKey(parts);
        const observation = readSalesObservation(get, definition.file, line, issues);
        if (!observation) return;
        if (salesKeys.has(key)) {
          duplicateKeys += 1;
          issues.add('DUPLICATE_KEY', definition.file, `결합 키 ${key}`, line);
          return;
        }
        salesKeys.add(key);
        quarters.add(parts.quarter);
        rememberAreaName(parts.areaType, parts.areaCode, get('areaName').trim());
        rememberIndustry(parts.industryCode, get('industryName').trim(), definition.year);
        if (supportedIndustry(parts.industryCode)) salesObservations.set(key, observation);
      },
    );
    files.push(record);
  }

  for (const definition of byRole('stores')) {
    log(`점포 ${definition.year}년 파일을 읽습니다.`);
    const schema = definition.year === 2024 ? STORES_SCHEMA_2024 : STORES_SCHEMA_2025;
    const record = parseTabularSource(
      options.sourceDir,
      definition,
      schema,
      issues,
      acceptChangedSource,
      (get, line) => {
        storeRows += 1;
        const parts = validatedKey(get, definition.file, line);
        if (!parts) return;
        const counts = readStoreCounts(get, definition.file, line, issues);
        if (!counts) return;
        if (counts.storeCount + counts.franchiseStoreCount !== counts.similarIndustryStoreCount) {
          storeCountIdentityMismatches += 1;
          issues.add(
            'STORE_COUNT_IDENTITY',
            definition.file,
            `점포_수 ${counts.storeCount} + 프랜차이즈 ${counts.franchiseStoreCount} ≠ 유사_업종 ${counts.similarIndustryStoreCount}`,
            line,
          );
        }
        const key = joinKey(parts);
        if (storeKeys.has(key)) {
          duplicateKeys += 1;
          issues.add('DUPLICATE_KEY', definition.file, `결합 키 ${key}`, line);
          return;
        }
        storeKeys.add(key);
        quarters.add(parts.quarter);
        rememberAreaName(parts.areaType, parts.areaCode, get('areaName').trim());
        rememberIndustry(parts.industryCode, get('industryName').trim(), definition.year);
        if (supportedIndustry(parts.industryCode)) storeCounts.set(key, counts);
      },
    );
    files.push(record);
  }

  let salesRowsMissingStores = 0;
  for (const key of salesKeys) {
    if (!storeKeys.has(key)) {
      salesRowsMissingStores += 1;
      issues.add('JOIN_MISSING_STORES', 'join', `매출 결합 키 ${key}에 점포 자료가 없습니다.`);
    }
  }
  const storeOnlyKeys = storeKeys.size - (salesKeys.size - salesRowsMissingStores);

  let areaNameMismatches = 0;
  for (const area of areas) {
    const observed = observedAreaNames.get(areaKey(area.areaType, area.areaCode));
    if (!observed || observed.size === 0) continue;
    const distinct = [...observed];
    const differing = distinct.filter((name) => name !== area.sourceName);
    if (differing.length === 0) continue;
    area.observedName = differing[0];
    areaNameMismatches += 1;
    issues.warn(
      'AREA_NAME_MISMATCH',
      'areas',
      `상권 ${area.areaType}/${area.areaCode}: 영역 파일 '${area.sourceName}' vs 매출·점포 파일 '${distinct.join(' | ')}'`,
    );
  }

  const industries: MarketIndustryRecord[] = [];
  for (const [code, names] of industryNames) {
    if (names.size > 1) {
      issues.warn(
        'INDUSTRY_NAME_CONFLICT',
        'industry',
        `업종 코드 ${code}의 원본 명칭이 여러 개입니다: ${[...names.keys()].join(', ')}`,
      );
    }
    const newest = industryNewest.get(code);
    const sourceName = newest?.name ?? [...names.keys()][0] ?? code;
    const supported = supportedIndustry(code);
    industries.push({
      code,
      sourceName,
      displayName: supported ? supported.displayName : sourceName,
      displayNameSource: supported ? 'PRODUCT_DOCUMENT' : 'SOURCE_FILE',
      sourceCategoryVersion: INDUSTRY_CATEGORY_VERSION,
      isSupported: supported !== null,
    });
  }
  industries.sort((left, right) => left.code.localeCompare(right.code));

  const quarterly: MarketQuarterlyRecord[] = [];
  for (const [key, observation] of salesObservations) {
    const parts = splitJoinKey(key);
    const counts = storeCounts.get(key);
    quarterly.push({
      ...parts,
      salesAmount: observation.salesAmount,
      salesCount: observation.salesCount,
      salesBreakdownJson: observation.salesBreakdownJson,
      storeCount: counts?.storeCount ?? null,
      similarIndustryStoreCount: counts?.similarIndustryStoreCount ?? null,
      franchiseStoreCount: counts?.franchiseStoreCount ?? null,
      openedStoreCount: counts?.openedStoreCount ?? null,
      closedStoreCount: counts?.closedStoreCount ?? null,
    });
  }
  let storeOnlyQuarterlyRows = 0;
  for (const [key, counts] of storeCounts) {
    if (salesObservations.has(key)) continue;
    storeOnlyQuarterlyRows += 1;
    quarterly.push({
      ...splitJoinKey(key),
      salesAmount: null,
      salesCount: null,
      salesBreakdownJson: null,
      storeCount: counts.storeCount,
      similarIndustryStoreCount: counts.similarIndustryStoreCount,
      franchiseStoreCount: counts.franchiseStoreCount,
      openedStoreCount: counts.openedStoreCount,
      closedStoreCount: counts.closedStoreCount,
    });
  }
  quarterly.sort((left, right) => {
    const leftKey = joinKey(left);
    const rightKey = joinKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  for (const industry of SUPPORTED_INDUSTRIES) {
    const count = quarterly.filter((row) => row.industryCode === industry.code).length;
    if (count === 0) {
      issues.add('MISSING_SUPPORTED_INDUSTRY', 'industry', `지원 업종 ${industry.code}의 분기 자료가 없습니다.`);
    }
  }

  const quarterList = [...quarters].sort();
  if (
    quarterList.length > 0 &&
    (quarterList[0] !== MARKET_BASIS_START_QUARTER || quarterList[quarterList.length - 1] !== MARKET_BASIS_END_QUARTER)
  ) {
    issues.warn(
      'INVALID_QUARTER',
      'join',
      `원본 분기 범위 ${quarterList[0]}~${quarterList[quarterList.length - 1]}가 릴리스 기준기간 ${MARKET_BASIS_START_QUARTER}~${MARKET_BASIS_END_QUARTER}와 다릅니다.`,
    );
  }

  const stats = {
    salesRows,
    storeRows,
    areaRows: areas.length,
    salesRowsMissingStores,
    storeOnlyKeys,
    duplicateKeys,
    storeCountIdentityMismatches,
    areaNameMismatches,
    salesRowsForSupportedIndustries: salesObservations.size,
    storeOnlyQuarterlyRows,
    quarters: quarterList,
  };

  const checks: MarketCheck[] = [
    check('매출 행', MARKET_RELEASE_EXPECTATIONS.salesRows, stats.salesRows),
    check('점포 행', MARKET_RELEASE_EXPECTATIONS.storesRows, stats.storeRows),
    check('영역 행', MARKET_RELEASE_EXPECTATIONS.areaRows, stats.areaRows),
    check('점포 자료가 없는 매출 행', MARKET_RELEASE_EXPECTATIONS.salesRowsMissingStores, stats.salesRowsMissingStores),
    check('결합 키 중복', MARKET_RELEASE_EXPECTATIONS.duplicateJoinKeys, stats.duplicateKeys),
    check('점포에만 있는 결합 키', MARKET_RELEASE_EXPECTATIONS.storeOnlyKeys, stats.storeOnlyKeys),
    check(
      '점포 수 항등식 위반',
      MARKET_RELEASE_EXPECTATIONS.storeCountIdentityMismatches,
      stats.storeCountIdentityMismatches,
    ),
  ];
  for (const entry of checks) {
    if (entry.passed) continue;
    const detail = `${entry.name}: 예상 ${entry.expected}, 실제 ${entry.actual}`;
    // A source that is knowingly different from the recorded bytes may also
    // have different totals; keep the failed check recorded instead of hiding it.
    if (acceptChangedSource) issues.warn('ROW_COUNT_MISMATCH', 'checks', detail);
    else issues.add('ROW_COUNT_MISMATCH', 'checks', detail);
  }
  issues.throwIfFailed();

  return {
    releaseKey: releaseKeyFor(files.map((file) => ({ file: file.file, sha256: file.sha256 }))),
    releaseLabel: MARKET_RELEASE_LABEL,
    files,
    checksumVerified: files.every((file) => file.checksumVerified),
    areas,
    industries,
    quarterly,
    stats,
    checks,
    warnings: issues.warnings,
  };
}

function check(name: string, expected: number, actual: number): MarketCheck {
  return { name, expected: String(expected), actual: String(actual), passed: expected === actual };
}

export function quarterRangeLabel(quarters: readonly string[]): string {
  if (quarters.length === 0) return '자료 없음';
  const first = quarters[0];
  const last = quarters[quarters.length - 1];
  return first === last ? quarterLabel(first) : `${quarterLabel(first)}~${quarterLabel(last)}`;
}

export type MarketLoadHooks = { beforeActivate?: () => Promise<void> | void };

export type MarketLoadOptions = {
  sourceDir: string;
  prisma: PrismaClient;
  // Synthetic fixtures may bypass the recorded source fingerprint only under
  // Vitest. The operator-facing loader never activates unverified bytes.
  allowUnverifiedSourceForTests?: boolean;
  log?: (message: string) => void;
  hooks?: MarketLoadHooks;
};

export type MarketLoadReport = {
  outcome: 'ACTIVATED' | 'ALREADY_ACTIVE';
  releaseId: string;
  releaseKey: string;
  label: string;
  areaCount: number;
  quarterlyRowCount: number;
  salesRows: number;
  storeRows: number;
  storeOnlyKeys: number;
  checksumVerified: boolean;
  checks: MarketCheck[];
  warnings: MarketIssue[];
};

const CHUNK_SIZE = 2000;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

async function insertAreas(
  prisma: PrismaClient,
  releaseId: string,
  areas: readonly MarketAreaRecord[],
  log: (message: string) => void,
) {
  for (const [index, group] of chunk(areas, CHUNK_SIZE).entries()) {
    await prisma.marketArea.createMany({ data: group.map((area) => ({ releaseId, ...area })) });
    log(`상권 ${Math.min((index + 1) * CHUNK_SIZE, areas.length)}/${areas.length}건 적재`);
  }
}

async function insertQuarterly(
  prisma: PrismaClient,
  releaseId: string,
  quarterly: readonly MarketQuarterlyRecord[],
  log: (message: string) => void,
) {
  for (const [index, group] of chunk(quarterly, CHUNK_SIZE).entries()) {
    await prisma.marketQuarterly.createMany({
      data: group.map(({ salesBreakdownJson, ...row }) => ({
        releaseId,
        ...row,
        ...(salesBreakdownJson === null ? {} : { salesBreakdownJson: salesBreakdownJson as Prisma.InputJsonValue }),
      })),
    });
    if ((index + 1) % 5 === 0 || (index + 1) * CHUNK_SIZE >= quarterly.length) {
      log(`분기 지표 ${Math.min((index + 1) * CHUNK_SIZE, quarterly.length)}/${quarterly.length}건 적재`);
    }
  }
}

async function upsertIndustries(prisma: PrismaClient, releaseId: string, industries: readonly MarketIndustryRecord[]) {
  for (const industry of industries) {
    await prisma.industry.upsert({
      where: { releaseId_code: { releaseId, code: industry.code } },
      create: { releaseId, ...industry },
      update: {
        sourceName: industry.sourceName,
        displayName: industry.displayName,
        displayNameSource: industry.displayNameSource,
        sourceCategoryVersion: industry.sourceCategoryVersion,
        isSupported: industry.isSupported,
      },
    });
  }
}

async function verifyPersistedRelease(prisma: PrismaClient, releaseId: string, parsed: ParsedMarketSources) {
  const [areaCount, quarterlyCount, salesRowCount, storeOnlyCount] = await Promise.all([
    prisma.marketArea.count({ where: { releaseId } }),
    prisma.marketQuarterly.count({ where: { releaseId } }),
    prisma.marketQuarterly.count({ where: { releaseId, salesAmount: { not: null } } }),
    prisma.marketQuarterly.count({ where: { releaseId, salesAmount: null } }),
  ]);
  const problems: string[] = [];
  if (areaCount !== parsed.areas.length) problems.push(`상권 ${areaCount} ≠ ${parsed.areas.length}`);
  if (quarterlyCount !== parsed.quarterly.length)
    problems.push(`분기 지표 ${quarterlyCount} ≠ ${parsed.quarterly.length}`);
  if (salesRowCount !== parsed.stats.salesRowsForSupportedIndustries) {
    problems.push(`매출 보유 행 ${salesRowCount} ≠ ${parsed.stats.salesRowsForSupportedIndustries}`);
  }
  if (storeOnlyCount !== parsed.stats.storeOnlyQuarterlyRows) {
    problems.push(`자료 부족 행 ${storeOnlyCount} ≠ ${parsed.stats.storeOnlyQuarterlyRows}`);
  }
  if (problems.length > 0) {
    throw new MarketSourceError('DB_VERIFICATION', `적재 후 검증에 실패했습니다: ${problems.join(', ')}`);
  }
}

async function markReleaseFailed(
  prisma: PrismaClient,
  releaseId: string,
  error: unknown,
  log: (message: string) => void,
) {
  const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  try {
    await prisma.marketQuarterly.deleteMany({ where: { releaseId } });
    await prisma.marketArea.deleteMany({ where: { releaseId } });
    await prisma.industry.deleteMany({ where: { releaseId } });
    await prisma.marketRelease.update({
      where: { id: releaseId },
      data: { status: 'FAILED', failedAt: new Date(), failureReason: reason.slice(0, 2000) },
    });
    log(`실패한 릴리스의 데이터를 정리했습니다. 기존 활성 릴리스는 그대로 유지됩니다: ${releaseId}`);
  } catch (cleanupError) {
    log(
      `실패 릴리스 정리 중 오류가 발생했습니다: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    );
  }
}

export async function loadMarketRelease(options: MarketLoadOptions): Promise<MarketLoadReport> {
  const log = options.log ?? (() => {});
  const prisma = options.prisma;
  if (options.allowUnverifiedSourceForTests && process.env.NODE_ENV !== 'test') {
    throw new MarketSourceError(
      'UNVERIFIED_SOURCE_FORBIDDEN',
      '검증되지 않은 원본은 테스트 환경에서만 적재할 수 있습니다. 운영 적재는 기록된 checksum의 원본만 허용합니다.',
    );
  }
  const parsed = readMarketSources({
    sourceDir: options.sourceDir,
    acceptChangedSource: options.allowUnverifiedSourceForTests === true,
    log,
  });

  const existing = await prisma.marketRelease.findUnique({ where: { releaseKey: parsed.releaseKey } });
  if (existing && existing.status === 'ACTIVE') {
    await upsertIndustries(prisma, existing.id, parsed.industries);
    log(`같은 릴리스가 이미 활성 상태입니다. 중복 적재하지 않습니다: ${existing.releaseKey}`);
    return {
      outcome: 'ALREADY_ACTIVE',
      releaseId: existing.id,
      releaseKey: existing.releaseKey,
      label: existing.label,
      areaCount: existing.areaCount,
      quarterlyRowCount: existing.quarterlyRowCount,
      salesRows: parsed.stats.salesRows,
      storeRows: parsed.stats.storeRows,
      storeOnlyKeys: parsed.stats.storeOnlyKeys,
      checksumVerified: parsed.checksumVerified,
      checks: parsed.checks,
      warnings: parsed.warnings,
    };
  }
  if (existing) {
    log(`완료되지 않은 같은 릴리스(${existing.status})를 정리하고 다시 적재합니다: ${existing.releaseKey}`);
    await prisma.marketRelease.delete({ where: { id: existing.id } });
  }
  if (!existing) {
    const active = await prisma.marketRelease.findFirst({ where: { status: 'ACTIVE' } });
    if (active) log(`기존 활성 릴리스는 검증이 끝날 때까지 그대로 서비스됩니다: ${active.releaseKey}`);
  }

  const release = await prisma.marketRelease.create({
    data: {
      releaseKey: parsed.releaseKey,
      label: parsed.releaseLabel,
      status: 'PENDING',
      schemaVersion: MARKET_SCHEMA_VERSION,
      definitionVersion: MARKET_DEFINITION_VERSION,
      sourceUrl: MARKET_SOURCE_URL,
      basisPeriod: `${MARKET_BASIS_START_QUARTER}-${MARKET_BASIS_END_QUARTER}`,
      basisPeriodLabel: MARKET_RELEASE_LABEL.replace('서울시 상권분석서비스 ', ''),
      retrievedAt: new Date(`${MARKET_RETRIEVED_AT}T00:00:00.000Z`),
      files: parsed.files,
      validationSummary: { checks: parsed.checks, warnings: parsed.warnings, stats: parsed.stats },
      areaCount: parsed.areas.length,
      quarterlyRowCount: parsed.quarterly.length,
    },
  });
  log(`임시 릴리스 ${release.releaseKey} 생성(${release.id}). 활성화 전까지 조회되지 않습니다.`);

  try {
    await upsertIndustries(prisma, release.id, parsed.industries);
    await insertAreas(prisma, release.id, parsed.areas, log);
    await insertQuarterly(prisma, release.id, parsed.quarterly, log);
    await verifyPersistedRelease(prisma, release.id, parsed);
    if (options.hooks?.beforeActivate) await options.hooks.beforeActivate();
    await prisma.$transaction(async (transaction) => {
      await transaction.marketRelease.updateMany({
        where: { status: 'ACTIVE', id: { not: release.id } },
        data: { status: 'SUPERSEDED' },
      });
      await transaction.marketRelease.update({
        where: { id: release.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      });
    });
  } catch (error) {
    await markReleaseFailed(prisma, release.id, error, log);
    throw error;
  }

  log(`릴리스 ${release.releaseKey}를 활성화했습니다.`);
  return {
    outcome: 'ACTIVATED',
    releaseId: release.id,
    releaseKey: release.releaseKey,
    label: release.label,
    areaCount: parsed.areas.length,
    quarterlyRowCount: parsed.quarterly.length,
    salesRows: parsed.stats.salesRows,
    storeRows: parsed.stats.storeRows,
    storeOnlyKeys: parsed.stats.storeOnlyKeys,
    checksumVerified: parsed.checksumVerified,
    checks: parsed.checks,
    warnings: parsed.warnings,
  };
}
