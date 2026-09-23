import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { contentHash, sha256Hex } from './checksum.ts';
import { decodeCp949, iterateCsvRows, normalizeHeaderRow } from './csv.ts';
import { parseDbf } from './dbf.ts';
import {
  resolveColumnIndex,
  SALES_SCHEMA_2024,
  SALES_SCHEMA_2025,
  STORES_HEADERS_2024,
  STORES_HEADERS_2025,
  STORES_SCHEMA_2024,
  STORES_SCHEMA_2025,
  type CanonicalColumn,
  type SourceSchema,
} from './headers.ts';
import { loadMarketRelease, readMarketSources } from './loader.ts';
import { basisPeriodCode, compareQuarters, parseQuarter, quarterLabel } from './quarter.ts';
import { MARKET_SOURCE_FILES, releaseKeyFor, type SourceFileRecord } from './source-files.ts';
import { MarketSourceError, isQuarterCode, parseAmountCell, parseCountCell } from './validation.ts';
import { getMarketSummary, listMarketAreas, listSupportedIndustries } from './read.ts';
import { readZipMember } from './zip.ts';

const RAW_DIR = fileURLToPath(new URL('../../../../data/raw/', import.meta.url));
const hasRawFiles = MARKET_SOURCE_FILES.every((definition) => existsSync(join(RAW_DIR, definition.file)));

// CP949 bytes for: 코드,이름\n3110127,"성수1가1동, 주민센터"\n
// Node cannot encode to CP949, so the bytes were produced once and pinned here.
const CP949_FIXTURE_HEX = 'c4dab5e52cc0ccb8a70a333131303132372c22bcbabcf631b0a131b5bf2c20c1d6b9cebcbec5cd220a';
const CP949_FIXTURE_TEXT = '코드,이름\n3110127,"성수1가1동, 주민센터"\n';

// The official CSV header row is Korean and encoded as CP949, which Node cannot
// encode. The exact header bytes are pinned here; data values in the fixtures
// stay ASCII so no test needs a CP949 encoder.
const CP949_HEADER_HEX: Readonly<Record<string, string>> = {
  'sales-2024':
    '22b1e2c1d85fb3e2bad0b1e25fc4dab5e5222c22bbf3b1c75fb1b8bad05fc4dab5e5222c22bbf3b1c75fb1b8bad05fc4dab5e55fb8ed222c22bbf3b1c75fc4dab5e5222c22bbf3b1c75fc4dab5e55fb8ed222c22bcadbaf1bdba5fbef7c1be5fc4dab5e5222c22bcadbaf1bdba5fbef7c1be5fc4dab5e55fb8ed222c22b4e7bff95fb8c5c3e25fb1ddbed7222c22b4e7bff95fb8c5c3e25fb0c7bcf6222c22c1d6c1df5fb8c5c3e25fb1ddbed7222c22c1d6b8bb5fb8c5c3e25fb1ddbed7222c22bff9bfe4c0cf5fb8c5c3e25fb1ddbed7222c22c8adbfe4c0cf5fb8c5c3e25fb1ddbed7222c22bcf6bfe4c0cf5fb8c5c3e25fb1ddbed7222c22b8f1bfe4c0cf5fb8c5c3e25fb1ddbed7222c22b1ddbfe4c0cf5fb8c5c3e25fb1ddbed7222c22c5e4bfe4c0cf5fb8c5c3e25fb1ddbed7222c22c0cfbfe4c0cf5fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f30307e30365fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f30367e31315fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f31317e31345fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f31347e31375fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f31377e32315fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f32317e32345fb8c5c3e25fb1ddbed7222c22b3b2bcba5fb8c5c3e25fb1ddbed7222c22bfa9bcba5fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f31305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f32305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f33305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f34305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f35305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f36305fc0ccbbf35fb8c5c3e25fb1ddbed7222c22c1d6c1df5fb8c5c3e25fb0c7bcf6222c22c1d6b8bb5fb8c5c3e25fb0c7bcf6222c22bff9bfe4c0cf5fb8c5c3e25fb0c7bcf6222c22c8adbfe4c0cf5fb8c5c3e25fb0c7bcf6222c22bcf6bfe4c0cf5fb8c5c3e25fb0c7bcf6222c22b8f1bfe4c0cf5fb8c5c3e25fb0c7bcf6222c22b1ddbfe4c0cf5fb8c5c3e25fb0c7bcf6222c22c5e4bfe4c0cf5fb8c5c3e25fb0c7bcf6222c22c0cfbfe4c0cf5fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e30365fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e31315fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e31345fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e31375fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e32315fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e32345fb8c5c3e25fb0c7bcf6222c22b3b2bcba5fb8c5c3e25fb0c7bcf6222c22bfa9bcba5fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f31305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f32305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f33305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f34305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f35305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f36305fc0ccbbf35fb8c5c3e25fb0c7bcf6220a',
  'sales-2025':
    '22b1e2c1d85fb3e2bad0b1e25fc4dab5e5222c22bbf3b1c75fb1b8bad05fc4dab5e5222c22bbf3b1c75fb1b8bad05fc4dab5e55fb8ed222c22bbf3b1c75fc4dab5e5222c22bbf3b1c75fc4dab5e55fb8ed222c22bcadbaf1bdba5fbef7c1be5fc4dab5e5222c22bcadbaf1bdba5fbef7c1be5fc4dab5e55fb8ed222c22b4e7bff95fb8c5c3e25fb1ddbed7222c22b4e7bff95fb8c5c3e25fb0c7bcf6222c22c1d6c1df5fb8c5c3e25fb1ddbed7222c22c1d6b8bb5fb8c5c3e25fb1ddbed7222c22bff9bfe4c0cf5fb8c5c3e25fb1ddbed7222c22c8adbfe4c0cf5fb8c5c3e25fb1ddbed7222c22bcf6bfe4c0cf5fb8c5c3e25fb1ddbed7222c22b8f1bfe4c0cf5fb8c5c3e25fb1ddbed7222c22b1ddbfe4c0cf5fb8c5c3e25fb1ddbed7222c22c5e4bfe4c0cf5fb8c5c3e25fb1ddbed7222c22c0cfbfe4c0cf5fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f30307e30365fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f30367e31315fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f31317e31345fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f31347e31375fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f31377e32315fb8c5c3e25fb1ddbed7222c22bdc3b0a3b4eb5f32317e32345fb8c5c3e25fb1ddbed7222c22b3b2bcba5fb8c5c3e25fb1ddbed7222c22bfa9bcba5fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f31305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f32305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f33305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f34305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f35305fb8c5c3e25fb1ddbed7222c22bfacb7c9b4eb5f36305fc0ccbbf35fb8c5c3e25fb1ddbed7222c22c1d6c1df5fb8c5c3e25fb0c7bcf6222c22c1d6b8bb5fb8c5c3e25fb0c7bcf6222c22bff9bfe4c0cf5fb8c5c3e25fb0c7bcf6222c22c8adbfe4c0cf5fb8c5c3e25fb0c7bcf6222c22bcf6bfe4c0cf5fb8c5c3e25fb0c7bcf6222c22b8f1bfe4c0cf5fb8c5c3e25fb0c7bcf6222c22b1ddbfe4c0cf5fb8c5c3e25fb0c7bcf6222c22c5e4bfe4c0cf5fb8c5c3e25fb0c7bcf6222c22c0cfbfe4c0cf5fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e30365fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e31315fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e31345fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e31375fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e32315fb8c5c3e25fb0c7bcf6222c22bdc3b0a3b4eb5fb0c7bcf67e32345fb8c5c3e25fb0c7bcf6222c22b3b2bcba5fb8c5c3e25fb0c7bcf6222c22bfa9bcba5fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f31305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f32305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f33305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f34305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f35305fb8c5c3e25fb0c7bcf6222c22bfacb7c9b4eb5f36305fc0ccbbf35fb8c5c3e25fb0c7bcf6220a',
  'stores-2024':
    '22b1e2c1d85fb3e2bad0b1e25fc4dab5e5222c22bbf3b1c75fb1b8bad05fc4dab5e5222c22bbf3b1c75fb1b8bad05fc4dab5e55fb8ed222c22bbf3b1c75fc4dab5e5222c22bbf3b1c75fc4dab5e55fb8ed222c22bcadbaf1bdba5fbef7c1be5fc4dab5e5222c22bcadbaf1bdba5fbef7c1be5fc4dab5e55fb8ed222c22c1a1c6f75fbcf6222c22c0afbbe75fbef7c1be5fc1a1c6f75fbcf6222c22b0b3bef75fc0b2222c22b0b3bef75fc1a1c6f75fbcf6222c22c6f3bef75fb7fc222c22c6f3bef75fc1a1c6f75fbcf6222c22c7c1b7a3c2f7c0ccc1ee5fc1a1c6f75fbcf6220a',
  'stores-2025':
    '22737464725f797971755f6364222c2274726461725f73655f6364222c2274726461725f73655f63645f6e6d222c2274726461725f6364222c2274726461725f63645f6e6d222c227376635f696e647574795f6364222c227376635f696e647574795f63645f6e6d222c2273746f725f636f222c2273696d696c725f696e647574795f73746f725f636f222c226f7062697a5f7274222c226f7062697a5f73746f725f636f222c22636c7362697a5f7274222c22636c7362697a5f73746f725f636f222c226672635f73746f725f636f220a',
};

function buildZipStore(entries: readonly { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    nameBytes.copy(local, 30);
    localParts.push(local, entry.data);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);
    centralParts.push(central);
    offset += local.length + entry.data.length;
  }
  const directory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, eocd]);
}

const AREA_DBF_FIELDS = [
  { name: 'TRDAR_SE_C', length: 1 },
  { name: 'TRDAR_SE_1', length: 12 },
  { name: 'TRDAR_CD', length: 10 },
  { name: 'TRDAR_CD_N', length: 60 },
  { name: 'XCNTS_VALU', length: 10 },
  { name: 'YDNTS_VALU', length: 10 },
  { name: 'SIGNGU_CD', length: 5 },
  { name: 'SIGNGU_CD_', length: 20 },
  { name: 'ADSTRD_CD', length: 8 },
  { name: 'ADSTRD_CD_', length: 20 },
  { name: 'RELM_AR', length: 10 },
];

function buildDbf(
  fields: readonly { name: string; length: number }[],
  rows: readonly Record<string, string>[],
): Buffer {
  const recordLength = 1 + fields.reduce((total, field) => total + field.length, 0);
  const headerLength = 32 + fields.length * 32 + 1;
  const buffer = Buffer.alloc(headerLength + rows.length * recordLength + 1);
  buffer[0] = 0x03;
  buffer.writeUInt32LE(rows.length, 4);
  buffer.writeUInt16LE(headerLength, 8);
  buffer.writeUInt16LE(recordLength, 10);
  fields.forEach((field, index) => {
    const start = 32 + index * 32;
    buffer.write(field.name, start, 11, 'latin1');
    buffer[start + 11] = 'C'.charCodeAt(0);
    buffer[start + 16] = field.length;
  });
  buffer[headerLength - 1] = 0x0d;
  rows.forEach((row, rowIndex) => {
    const start = headerLength + rowIndex * recordLength;
    buffer[start] = 0x20;
    let cursor = start + 1;
    for (const field of fields) {
      const value = Buffer.from(row[field.name] ?? '', 'utf8');
      if (value.length > field.length) throw new Error(`${field.name} 값이 필드 길이를 넘습니다.`);
      value.copy(buffer, cursor);
      cursor += field.length;
    }
  });
  buffer[buffer.length - 1] = 0x1a;
  return buffer;
}

type RowValues = Partial<Record<CanonicalColumn, string>>;

function buildTabular(schema: SourceSchema, rows: readonly RowValues[]): Buffer {
  const pinnedHeader = CP949_HEADER_HEX[schema.id];
  if (pinnedHeader === undefined) throw new Error(`고정된 CP949 헤더가 없습니다: ${schema.id}`);
  const lines = rows.map((row) =>
    [...schema.expectedHeaders]
      .map((name) => {
        const canonical = schema.columns[name];
        return csvCell(canonical === undefined ? '' : (row[canonical] ?? ''));
      })
      .join(','),
  );
  const body = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return Buffer.concat([Buffer.from(pinnedHeader, 'hex'), Buffer.from(body, 'utf8')]);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function areaRow(
  overrides: Partial<Record<string, string>> & { TRDAR_CD: string; TRDAR_CD_N: string },
): Record<string, string> {
  return {
    TRDAR_SE_C: 'A',
    TRDAR_SE_1: '골목상권',
    XCNTS_VALU: '200000',
    YDNTS_VALU: '450000',
    SIGNGU_CD: '11200',
    SIGNGU_CD_: '성동구',
    ADSTRD_CD: '11200650',
    ADSTRD_CD_: '성수1가1동',
    RELM_AR: '1000',
    ...overrides,
  };
}

// CSV fixtures stay ASCII because the store and sales files are read as CP949,
// and Node cannot encode Korean to CP949. Korean attribute coverage comes from
// the DBF fixture below and from the recorded files when they are present.
const DEFAULT_AREA_NAMES = ['TestArea1', 'TestArea2', 'TestArea3'] as const;

function salesRow(overrides: RowValues): RowValues {
  return {
    areaType: 'A',
    areaName: 'TestArea1',
    industryName: 'KoreanFood',
    salesCount: '10',
    weekdayAmount: '70',
    weekendAmount: '30',
    mondayAmount: '10',
    tuesdayAmount: '10',
    wednesdayAmount: '10',
    thursdayAmount: '10',
    fridayAmount: '30',
    saturdayAmount: '20',
    sundayAmount: '10',
    time0006Amount: '5',
    time0611Amount: '5',
    time1114Amount: '20',
    time1417Amount: '10',
    time1721Amount: '40',
    time2124Amount: '20',
    maleAmount: '55',
    femaleAmount: '45',
    age10Amount: '5',
    age20Amount: '20',
    age30Amount: '25',
    age40Amount: '20',
    age50Amount: '20',
    age60Amount: '10',
    weekdayCount: '7',
    weekendCount: '3',
    mondayCount: '1',
    tuesdayCount: '1',
    wednesdayCount: '1',
    thursdayCount: '1',
    fridayCount: '3',
    saturdayCount: '2',
    sundayCount: '1',
    time0006Count: '1',
    time0611Count: '1',
    time1114Count: '2',
    time1417Count: '1',
    time1721Count: '3',
    time2124Count: '2',
    maleCount: '6',
    femaleCount: '4',
    age10Count: '1',
    age20Count: '2',
    age30Count: '2',
    age40Count: '2',
    age50Count: '2',
    age60Count: '1',
    ...overrides,
  };
}

function storeRow(overrides: RowValues): RowValues {
  return {
    areaType: 'A',
    areaName: 'TestArea1',
    industryName: 'KoreanFood',
    storeCount: '10',
    similarIndustryStoreCount: '13',
    franchiseStoreCount: '3',
    openedStoreCount: '0',
    closedStoreCount: '0',
    ...overrides,
  };
}

const DEFAULT_AREAS = [
  areaRow({ TRDAR_CD: '3110001', TRDAR_CD_N: DEFAULT_AREA_NAMES[0] }),
  areaRow({ TRDAR_CD: '3110002', TRDAR_CD_N: DEFAULT_AREA_NAMES[1] }),
  areaRow({ TRDAR_CD: '3110003', TRDAR_CD_N: DEFAULT_AREA_NAMES[2] }),
];

// Korean attributes to prove the DBF is decoded as UTF-8, not CP949.
const KOREAN_AREAS = [
  areaRow({ TRDAR_CD: '3110008', TRDAR_CD_N: '혜화동주민센터', SIGNGU_CD_: '종로구', ADSTRD_CD_: '청운효자동' }),
];

const DEFAULT_SALES_2024: RowValues[] = [
  salesRow({ quarter: '20241', areaCode: '3110001', industryCode: 'CS100001', salesAmount: '123456789' }),
  salesRow({
    quarter: '20242',
    areaCode: '3110001',
    industryCode: 'CS100010',
    industryName: 'CoffeeDrinks',
    salesAmount: '0',
  }),
  salesRow({
    quarter: '20241',
    areaCode: '3110001',
    industryCode: 'CS100002',
    industryName: 'ChineseFood',
    salesAmount: '555',
  }),
];

const DEFAULT_SALES_2025: RowValues[] = [
  salesRow({ quarter: '20251', areaCode: '3110001', industryCode: 'CS100001', salesAmount: '987654321012' }),
];

const DEFAULT_STORES_2024: RowValues[] = [
  storeRow({ quarter: '20241', areaCode: '3110001', industryCode: 'CS100001' }),
  storeRow({
    quarter: '20242',
    areaCode: '3110001',
    industryCode: 'CS100010',
    industryName: 'CoffeeDrinks',
    storeCount: '5',
    similarIndustryStoreCount: '6',
    franchiseStoreCount: '1',
    openedStoreCount: '1',
  }),
  storeRow({
    quarter: '20241',
    areaCode: '3110002',
    industryCode: 'CS100001',
    areaName: 'TestArea2',
    storeCount: '7',
    similarIndustryStoreCount: '9',
    franchiseStoreCount: '2',
    closedStoreCount: '1',
  }),
  storeRow({
    quarter: '20241',
    areaCode: '3110001',
    industryCode: 'CS100002',
    industryName: 'ChineseFood',
    storeCount: '4',
    similarIndustryStoreCount: '5',
    franchiseStoreCount: '1',
  }),
];

const DEFAULT_STORES_2025: RowValues[] = [
  storeRow({
    quarter: '20251',
    areaCode: '3110001',
    industryCode: 'CS100001',
    storeCount: '11',
    similarIndustryStoreCount: '14',
    openedStoreCount: '1',
  }),
];

type SourceFiles = {
  areas: readonly Record<string, string>[];
  sales2024: readonly RowValues[];
  sales2025: readonly RowValues[];
  stores2024: readonly RowValues[];
  stores2025: readonly RowValues[];
};

function writeSources(overrides: Partial<SourceFiles> = {}): string {
  const sources: SourceFiles = {
    areas: DEFAULT_AREAS,
    sales2024: DEFAULT_SALES_2024,
    sales2025: DEFAULT_SALES_2025,
    stores2024: DEFAULT_STORES_2024,
    stores2025: DEFAULT_STORES_2025,
    ...overrides,
  };
  const dir = mkdtempSync(join(tmpdir(), 'trendbench-market-'));
  createdDirs.push(dir);
  writeFileSync(
    join(dir, 'areas.zip'),
    buildZipStore([
      { name: 'areas.dbf', data: buildDbf(AREA_DBF_FIELDS, sources.areas) },
      { name: 'areas.cpg', data: Buffer.from('UTF-8', 'utf8') },
    ]),
  );
  writeFileSync(
    join(dir, 'sales-2024.zip'),
    buildZipStore([{ name: 'sales-2024.csv', data: buildTabular(SALES_SCHEMA_2024, sources.sales2024) }]),
  );
  writeFileSync(
    join(dir, 'sales-2025.zip'),
    buildZipStore([{ name: 'sales-2025.csv', data: buildTabular(SALES_SCHEMA_2025, sources.sales2025) }]),
  );
  writeFileSync(
    join(dir, 'stores-2024.zip'),
    buildZipStore([{ name: 'stores-2024.csv', data: buildTabular(STORES_SCHEMA_2024, sources.stores2024) }]),
  );
  writeFileSync(
    join(dir, 'stores-2025.zip'),
    buildZipStore([{ name: 'stores-2025.csv', data: buildTabular(STORES_SCHEMA_2025, sources.stores2025) }]),
  );
  return dir;
}

const createdDirs: string[] = [];

function expectSourceError(run: () => unknown): MarketSourceError {
  try {
    run();
  } catch (error) {
    if (error instanceof MarketSourceError) return error;
    throw error;
  }
  throw new Error('MarketSourceError가 발생하지 않았습니다.');
}

describe('quarter codes', () => {
  it('parses and labels the source quarter format', () => {
    expect(parseQuarter('20241')).toEqual({ raw: '20241', year: 2024, quarter: 1 });
    expect(quarterLabel('20254')).toBe('2025년 4분기');
    expect(basisPeriodCode('20241', '20254')).toBe('2024Q1-2025Q4');
  });

  it('rejects a quarter outside the 1-4 range', () => {
    expect(isQuarterCode('20245')).toBe(false);
    expect(isQuarterCode('2024')).toBe(false);
    expect(parseQuarter('20250')).toBeNull();
  });

  it('orders quarters oldest first', () => {
    expect(['20251', '20241', '20254'].sort(compareQuarters)).toEqual(['20241', '20251', '20254']);
  });
});

describe('source header mapping', () => {
  it('maps the recorded 2024 Korean store headers', () => {
    const index = resolveColumnIndex(STORES_SCHEMA_2024, [...STORES_HEADERS_2024]);
    expect(index.quarter).toBe(0);
    expect(index.storeCount).toBe(7);
    expect(index.similarIndustryStoreCount).toBe(8);
    expect(index.closedStoreCount).toBe(12);
    expect(index.franchiseStoreCount).toBe(13);
  });

  it('maps the recorded 2025 English store headers to the same canonical columns', () => {
    const index = resolveColumnIndex(STORES_SCHEMA_2025, [...STORES_HEADERS_2025]);
    expect(index.quarter).toBe(0);
    expect(index.storeCount).toBe(7);
    expect(index.similarIndustryStoreCount).toBe(8);
    expect(index.closedStoreCount).toBe(12);
    expect(index.franchiseStoreCount).toBe(13);
  });

  it('uses one record sales header set for both years', () => {
    expect(SALES_SCHEMA_2024.expectedHeaders).toEqual(SALES_SCHEMA_2025.expectedHeaders);
    const index = resolveColumnIndex(SALES_SCHEMA_2024, [...SALES_SCHEMA_2024.expectedHeaders]);
    expect(index.salesAmount).toBe(7);
    expect(index.industryCode).toBe(5);
  });

  it('rejects the 2025 English store file under the 2024 Korean schema', () => {
    const error = expectSourceError(() => resolveColumnIndex(STORES_SCHEMA_2024, [...STORES_HEADERS_2025]));
    expect(error.code).toBe('UNEXPECTED_HEADER');
  });

  it('rejects a renamed column even when the count matches', () => {
    const headers = [...STORES_HEADERS_2025];
    headers[7] = 'store_count';
    const error = expectSourceError(() => resolveColumnIndex(STORES_SCHEMA_2025, headers));
    expect(error.message).toContain('예상한 열 구성과 다릅니다');
  });
});

describe('CP949 CSV reading', () => {
  it('decodes CP949 bytes and keeps quoted commas', () => {
    const text = decodeCp949(Buffer.from(CP949_FIXTURE_HEX, 'hex'), 'fixture');
    expect(text).toBe(CP949_FIXTURE_TEXT);
    const rows = [...iterateCsvRows(text)];
    expect(normalizeHeaderRow(rows[0])).toEqual(['코드', '이름']);
    expect(rows[1]).toEqual(['3110127', '성수1가1동, 주민센터']);
  });

  it('rejects bytes that are not valid CP949', () => {
    expect(() => decodeCp949(Buffer.from('ff', 'hex'), 'fixture')).toThrow(/알 수 없는 문자/);
  });

  it('pins CP949 header bytes that match the recorded schemas', () => {
    for (const schema of [SALES_SCHEMA_2024, SALES_SCHEMA_2025, STORES_SCHEMA_2024, STORES_SCHEMA_2025]) {
      const text = decodeCp949(Buffer.from(CP949_HEADER_HEX[schema.id] ?? '', 'hex'), 'fixture');
      const rows = [...iterateCsvRows(text)];
      expect(normalizeHeaderRow(rows[0])).toEqual([...schema.expectedHeaders]);
    }
  });

  it('parses headers and values through a stored zip entry', () => {
    const csv = buildTabular(SALES_SCHEMA_2024, DEFAULT_SALES_2024);
    const zip = buildZipStore([{ name: 'sales-2024.csv', data: csv }]);
    const member = readZipMember(zip, '.csv', (raw) => decodeCp949(raw, 'ZIP 항목 이름'));
    expect(member.entry.name).toBe('sales-2024.csv');
    const rows = [...iterateCsvRows(decodeCp949(member.data, 'fixture'))];
    expect(normalizeHeaderRow(rows[0])[7]).toBe('당월_매출_금액');
  });
});

describe('DBF attribute reading', () => {
  it('reads UTF-8 attributes, field names and the record count', () => {
    const table = parseDbf(buildDbf(AREA_DBF_FIELDS, KOREAN_AREAS));
    expect(table.recordCount).toBe(1);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].TRDAR_CD).toBe('3110008');
    expect(table.rows[0].TRDAR_CD_N).toBe('혜화동주민센터');
    expect(table.rows[0]['SIGNGU_CD_']).toBe('종로구');
    expect(table.rows[0].TRDAR_SE_1).toBe('골목상권');
    expect(table.fields.map((field) => field.name)).toContain('TRDAR_SE_1');
  });

  it('skips records marked as deleted', () => {
    const data = buildDbf(AREA_DBF_FIELDS, DEFAULT_AREAS);
    data[32 + AREA_DBF_FIELDS.length * 32 + 1] = 0x2a;
    const table = parseDbf(data);
    expect(table.recordCount).toBe(3);
    expect(table.rows).toHaveLength(2);
  });

  it('rejects a file whose field definitions have no terminator', () => {
    const data = buildDbf(AREA_DBF_FIELDS, DEFAULT_AREAS);
    data[32 + AREA_DBF_FIELDS.length * 32] = 0x20;
    expect(() => parseDbf(data)).toThrow(/종료 바이트/);
  });
});

describe('checksums and release identity', () => {
  it('computes SHA-256 of a known buffer', () => {
    expect(sha256Hex('trendbench')).toBe('c5009a3e523174413e1ac3664e30bf400da1406e0578deb92db5efb597880c15');
  });

  it('fingerprints content independently of file order', () => {
    const files = [
      { file: 'a.zip', sha256: 'aa' },
      { file: 'b.zip', sha256: 'bb' },
    ];
    expect(contentHash(files)).toBe(contentHash([...files].reverse()));
    expect(contentHash(files)).not.toBe(contentHash([{ file: 'a.zip', sha256: 'aa' }]));
  });

  it('derives a stable release key from the recorded files', () => {
    const files = MARKET_SOURCE_FILES.map((definition) => ({
      file: definition.file,
      sha256: definition.expectedSha256,
    }));
    expect(releaseKeyFor(files)).toBe(releaseKeyFor([...files].reverse()));
    expect(releaseKeyFor(files)).toMatch(/^seoul-market-2024q1-2025q4-[0-9a-f]{12}$/);
  });
});

describe('cell validation', () => {
  it('keeps 0 separate from a missing value', () => {
    expect(parseAmountCell('0')).toEqual({ ok: true, amount: '0' });
    expect(parseAmountCell('')).toEqual({ ok: false, reason: 'NON_NUMERIC_AMOUNT' });
    expect(parseAmountCell('   ')).toEqual({ ok: false, reason: 'NON_NUMERIC_AMOUNT' });
    expect(parseCountCell('0')).toEqual({ ok: true, count: 0 });
    expect(parseCountCell('')).toEqual({ ok: false, reason: 'NON_NUMERIC_COUNT' });
  });

  it('rejects negative and non-integer amounts', () => {
    expect(parseAmountCell('-1')).toEqual({ ok: false, reason: 'NEGATIVE_AMOUNT' });
    expect(parseAmountCell('1.5')).toEqual({ ok: false, reason: 'NON_NUMERIC_AMOUNT' });
    expect(parseAmountCell('1e3')).toEqual({ ok: false, reason: 'NON_NUMERIC_AMOUNT' });
    expect(parseCountCell('-2')).toEqual({ ok: false, reason: 'NEGATIVE_AMOUNT' });
  });

  it('preserves integer precision as a string', () => {
    const parsed = parseAmountCell('987654321012345678');
    expect(parsed).toEqual({ ok: true, amount: '987654321012345678' });
    expect(typeof (parsed as { amount: string }).amount).toBe('string');
  });
});

describe('source pipeline', () => {
  it('builds quarterly rows, keeping store-only sales null and explicit zero', () => {
    const parsed = readMarketSources({ sourceDir: writeSources(), acceptChangedSource: true });
    expect(parsed.stats.quarters).toEqual(['20241', '20242', '20251']);
    expect(parsed.quarterly).toHaveLength(4);
    expect(parsed.stats.duplicateKeys).toBe(0);
    expect(parsed.stats.salesRowsMissingStores).toBe(0);
    expect(parsed.stats.storeOnlyQuarterlyRows).toBe(1);

    const explicitZero = parsed.quarterly.find((row) => row.quarter === '20242' && row.industryCode === 'CS100010');
    expect(explicitZero?.salesAmount).toBe('0');

    const storeOnly = parsed.quarterly.find((row) => row.areaCode === '3110002');
    expect(storeOnly?.salesAmount).toBeNull();
    expect(storeOnly?.storeCount).toBe(7);

    expect(parsed.quarterly.find((row) => row.industryCode === 'CS100002')).toBeUndefined();
    expect(parsed.industries.find((industry) => industry.code === 'CS100002')?.isSupported).toBe(false);
    expect(parsed.industries.find((industry) => industry.code === 'CS100010')).toMatchObject({
      displayName: '커피·음료',
      displayNameSource: 'PRODUCT_DOCUMENT',
    });
    expect(parsed.industries.find((industry) => industry.code === 'CS100002')).toMatchObject({
      displayName: 'ChineseFood',
      displayNameSource: 'SOURCE_FILE',
    });
  });

  it('rejects duplicate join keys', () => {
    const duplicate = [
      ...DEFAULT_SALES_2024,
      salesRow({ quarter: '20241', areaCode: '3110001', industryCode: 'CS100001', salesAmount: '9' }),
    ];
    const error = expectSourceError(() =>
      readMarketSources({ sourceDir: writeSources({ sales2024: duplicate }), acceptChangedSource: true }),
    );
    expect(error.errorCounts?.DUPLICATE_KEY).toBe(1);
  });

  it('rejects an invalid quarter, a missing key and a negative amount', () => {
    const badQuarter = [
      ...DEFAULT_SALES_2024,
      salesRow({ quarter: '20245', areaCode: '3110001', industryCode: 'CS100001', salesAmount: '1' }),
    ];
    expect(
      expectSourceError(() =>
        readMarketSources({ sourceDir: writeSources({ sales2024: badQuarter }), acceptChangedSource: true }),
      ).errorCounts?.INVALID_QUARTER,
    ).toBe(1);

    const missingKey = [
      ...DEFAULT_SALES_2024,
      salesRow({ quarter: '20241', areaCode: '', industryCode: 'CS100001', salesAmount: '1' }),
    ];
    expect(
      expectSourceError(() =>
        readMarketSources({ sourceDir: writeSources({ sales2024: missingKey }), acceptChangedSource: true }),
      ).errorCounts?.INVALID_AREA_CODE,
    ).toBe(1);

    const negative = [
      ...DEFAULT_SALES_2024,
      salesRow({ quarter: '20241', areaCode: '3110001', industryCode: 'CS100001', salesAmount: '-500' }),
    ];
    expect(
      expectSourceError(() =>
        readMarketSources({ sourceDir: writeSources({ sales2024: negative }), acceptChangedSource: true }),
      ).errorCounts?.NEGATIVE_AMOUNT,
    ).toBe(1);
  });

  it('rejects a sales key with no store row and an area missing from the area file', () => {
    const missingStores = [
      ...DEFAULT_SALES_2024,
      salesRow({ quarter: '20243', areaCode: '3110001', industryCode: 'CS100001', salesAmount: '1' }),
    ];
    const error = expectSourceError(() =>
      readMarketSources({ sourceDir: writeSources({ sales2024: missingStores }), acceptChangedSource: true }),
    );
    expect(error.errorCounts?.JOIN_MISSING_STORES).toBe(1);

    const unknownArea = [
      ...DEFAULT_SALES_2024,
      salesRow({ quarter: '20243', areaCode: '3119999', industryCode: 'CS100001', salesAmount: '1' }),
    ];
    const unknownError = expectSourceError(() =>
      readMarketSources({ sourceDir: writeSources({ sales2024: unknownArea }), acceptChangedSource: true }),
    );
    expect(unknownError.errorCounts?.UNKNOWN_AREA).toBe(1);
  });

  it('rejects a source file whose checksum is not the recorded one', () => {
    const error = expectSourceError(() => readMarketSources({ sourceDir: writeSources() }));
    expect(error.errorCounts?.CHECKSUM_MISMATCH ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('records checksum and row-count checks as warnings only when explicitly accepted', () => {
    const parsed = readMarketSources({ sourceDir: writeSources(), acceptChangedSource: true });
    expect(parsed.checksumVerified).toBe(false);
    expect(parsed.checks.every((check) => check.passed)).toBe(false);
    expect(parsed.warnings.map((warning) => warning.code)).toContain('CHECKSUM_MISMATCH');
    expect(parsed.warnings.map((warning) => warning.code)).toContain('ROW_COUNT_MISMATCH');
  });
});

describe.skipIf(!hasRawFiles)('recorded 2024-2025 source files', () => {
  it('reproduces every recorded count and joins sales to stores one to one', () => {
    const parsed = readMarketSources({ sourceDir: RAW_DIR });
    expect(parsed.checksumVerified).toBe(true);
    expect(parsed.checks.filter((check) => !check.passed)).toEqual([]);
    expect(parsed.stats.salesRows).toBe(172911);
    expect(parsed.stats.storeRows).toBe(611664);
    expect(parsed.stats.areaRows).toBe(1650);
    expect(parsed.stats.salesRowsMissingStores).toBe(0);
    expect(parsed.stats.duplicateKeys).toBe(0);
    expect(parsed.stats.storeOnlyKeys).toBe(438753);
    expect(parsed.stats.storeCountIdentityMismatches).toBe(0);
    expect(parsed.stats.quarters).toEqual(['20241', '20242', '20243', '20244', '20251', '20252', '20253', '20254']);
    expect(parsed.areas).toHaveLength(1650);
    expect(parsed.industries.filter((industry) => industry.isSupported).map((industry) => industry.code)).toEqual([
      'CS100001',
      'CS100010',
    ]);
  }, 120000);

  it('keeps store-only combinations as 자료 부족 instead of 0', () => {
    const parsed = readMarketSources({ sourceDir: RAW_DIR });
    const storeOnly = parsed.quarterly.filter((row) => row.salesAmount === null);
    expect(storeOnly).toHaveLength(4870);
    expect(storeOnly.every((row) => row.storeCount !== null)).toBe(true);
    expect(parsed.quarterly.some((row) => row.salesAmount === '0')).toBe(false);
  }, 120000);

  it('reproduces the recorded sample for 상권 3110127 / 커피·음료', () => {
    const parsed = readMarketSources({ sourceDir: RAW_DIR });
    const rows = parsed.quarterly
      .filter((row) => row.areaCode === '3110127' && row.industryCode === 'CS100010')
      .sort((left, right) => compareQuarters(left.quarter, right.quarter));
    expect(rows.map((row) => row.salesAmount)).toEqual([
      '166652371',
      '159475273',
      '155928466',
      '229353124',
      '183367983',
      '220443234',
      '255984520',
      '184219542',
    ]);
    expect(rows[0]).toMatchObject({
      storeCount: 10,
      similarIndustryStoreCount: 13,
      franchiseStoreCount: 3,
      openedStoreCount: 0,
      closedStoreCount: 0,
    });
    expect(rows[4]).toMatchObject({
      storeCount: 10,
      similarIndustryStoreCount: 13,
      openedStoreCount: 0,
      closedStoreCount: 0,
    });
  }, 120000);

  it('keeps both recorded names for 상권 3110024', () => {
    const parsed = readMarketSources({ sourceDir: RAW_DIR });
    const area = parsed.areas.find((entry) => entry.areaCode === '3110024');
    expect(area?.sourceName).toBe('혜회동주민센터');
    expect(area?.observedName).toBe('혜화동주민센터');
    expect(parsed.warnings.some((warning) => warning.code === 'AREA_NAME_MISMATCH')).toBe(true);
  }, 120000);

  it('compares the recorded source checksums with the release manifest', () => {
    const parsed = readMarketSources({ sourceDir: RAW_DIR });
    for (const definition of MARKET_SOURCE_FILES) {
      const record = parsed.files.find((file: SourceFileRecord) => file.file === definition.file);
      expect(record?.sha256).toBe(definition.expectedSha256);
    }
  }, 120000);

  it('decodes the CP949 zip entry names of the official files', () => {
    const member = readZipMember(readFileSync(join(RAW_DIR, 'sales-2024.zip')), '.csv', (raw) =>
      decodeCp949(raw, 'ZIP 항목 이름'),
    );
    expect(member.entry.name).toContain('추정매출-상권');
    expect(member.entry.name).toContain('2024');
  });
});

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

// These tests exercise the real loader and the real query layer against the
// configured PostgreSQL. They load only synthetic releases, delete them again,
// and restore whatever release was ACTIVE before the run.
describe.skipIf(!process.env.TEST_DATABASE_URL)('loading releases into PostgreSQL', () => {
  let client: PrismaClient | null = null;
  let previousActiveId: string | null = null;
  let firstReleaseKey = '';
  let startedAt = new Date(0);

  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    startedAt = new Date();
    const active = await db().marketRelease.findFirst({ where: { status: 'ACTIVE' } });
    previousActiveId = active?.id ?? null;
  });

  afterAll(async () => {
    const releases = await db().marketRelease.findMany({ where: { createdAt: { gte: startedAt } } });
    for (const release of releases) await db().marketRelease.delete({ where: { id: release.id } });
    if (previousActiveId) {
      const previous = await db().marketRelease.findUnique({ where: { id: previousActiveId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().marketRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
        await db().marketRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
  });

  it('activates a validated release and serves it through the public queries', async () => {
    const report = await loadMarketRelease({
      sourceDir: writeSources(),
      prisma: db(),
      allowUnverifiedSourceForTests: true,
      log: () => {},
    });
    expect(report.outcome).toBe('ACTIVATED');
    expect(report.areaCount).toBe(3);
    expect(report.quarterlyRowCount).toBe(4);
    expect(report.checks).toHaveLength(7);
    expect(report.checks.every((check) => check.passed)).toBe(false);
    firstReleaseKey = report.releaseKey;

    const payload = await prismaAreas('11200');
    expect(payload.districts).toEqual([{ districtCode: '11200', districtName: '성동구', areaCount: 3 }]);
    expect(payload.areas).toHaveLength(3);
    expect(payload.areas.map((area) => area.areaCode)).toEqual(['3110001', '3110002', '3110003']);
    expect(payload.release.releaseKey).toBe(firstReleaseKey);
    expect(payload.release.quarterlyRowCount).toBe(4);
    expect(payload.release.sources.map((source) => source.fileName)).toEqual([
      'areas.zip',
      'sales-2024.zip',
      'sales-2025.zip',
      'stores-2024.zip',
      'stores-2025.zip',
    ]);
    expect(payload.release.sources[1].sha256).toHaveLength(64);

    const withoutDistrict = await listMarketAreas(db(), null);
    expect(withoutDistrict.kind).toBe('OK');
    if (withoutDistrict.kind === 'OK') expect(withoutDistrict.payload.areas).toEqual([]);

    const unknownDistrict = await listMarketAreas(db(), '99999');
    expect(unknownDistrict.kind).toBe('INVALID_DISTRICT_CODE');

    const industries = await listSupportedIndustries(db());
    expect(industries.industries.map((industry) => industry.code)).toEqual(['CS100001', 'CS100010']);
    expect(industries.activeRelease?.releaseKey).toBe(firstReleaseKey);
  }, 120000);

  it('returns quarters oldest first with amount strings and 자료 부족 for missing sales', async () => {
    const available = await prismaSummary('3110001', 'CS100001');
    expect(available.availableQuarters.map((quarter) => quarter.quarter)).toEqual(['20241', '20251']);
    expect(available.quarters.map((quarter) => quarter.salesAmount)).toEqual(['123456789', '987654321012']);
    expect(available.quarters.map((quarter) => quarter.salesCount)).toEqual(['10', '10']);
    expect(available.quarters[0].salesBreakdown?.timeOfDay).toHaveLength(6);
    expect(available.quarters[0].salesBreakdown?.gender.map((point) => point.label)).toEqual(['남성', '여성']);
    expect(available.dataStatus).toBe('AVAILABLE');
    expect(available.quarters[0]).toMatchObject({
      storeCount: 10,
      similarIndustryStoreCount: 13,
      franchiseStoreCount: 3,
      openedStoreCount: 0,
      closedStoreCount: 0,
    });

    const zero = await prismaSummary('3110001', 'CS100010');
    expect(zero.quarters.map((quarter) => quarter.salesAmount)).toEqual(['0']);
    expect(zero.dataStatus).toBe('AVAILABLE');

    const storeOnly = await prismaSummary('3110002', 'CS100001');
    expect(storeOnly.dataStatus).toBe('PARTIAL');
    expect(storeOnly.quarters[0].salesAmount).toBeNull();
    expect(storeOnly.quarters[0].salesStatus).toBe('NOT_PROVIDED');
    expect(storeOnly.quarters[0].storeCount).toBe(7);
    expect(storeOnly.dataStatusMessage).toContain('자료 부족');

    const none = await prismaSummary('3110003', 'CS100001');
    expect(none.dataStatus).toBe('NOT_PROVIDED');
    expect(none.quarters).toEqual([]);
    expect(none.availableQuarters).toEqual([]);
  }, 120000);

  it('separates malformed codes, unknown areas and unsupported industries', async () => {
    expect((await getMarketSummary(db(), { areaCode: '311', industryCode: 'CS100001' })).kind).toBe(
      'INVALID_AREA_CODE',
    );
    expect((await getMarketSummary(db(), { areaCode: '9999999', industryCode: 'CS100001' })).kind).toBe(
      'AREA_NOT_FOUND',
    );
    expect((await getMarketSummary(db(), { areaCode: '3110001', industryCode: 'CS999999' })).kind).toBe(
      'INVALID_INDUSTRY_CODE',
    );
    expect((await getMarketSummary(db(), { areaCode: '3110001', industryCode: 'CS100002' })).kind).toBe(
      'UNSUPPORTED_INDUSTRY',
    );
  }, 120000);

  it('reloading the same release is idempotent', async () => {
    const before = await releaseRowCounts(firstReleaseKey);
    const report = await loadMarketRelease({
      sourceDir: writeSources(),
      prisma: db(),
      allowUnverifiedSourceForTests: true,
      log: () => {},
    });
    expect(report.outcome).toBe('ALREADY_ACTIVE');
    expect(report.releaseKey).toBe(firstReleaseKey);
    const after = await releaseRowCounts(firstReleaseKey);
    expect(after).toEqual(before);
    const duplicates = await db().marketQuarterly.groupBy({
      by: ['releaseId', 'quarter', 'areaType', 'areaCode', 'industryCode'],
      where: { releaseId: await releaseIdFor(firstReleaseKey) },
      _count: { _all: true },
      having: { quarter: { _count: { gt: 1 } } },
    });
    expect(duplicates).toEqual([]);
    expect(await db().marketRelease.count({ where: { releaseKey: firstReleaseKey } })).toBe(1);
  }, 120000);

  it('a release that fails during loading leaves the active release untouched', async () => {
    const activeIndustryBefore = await db().industry.findUnique({
      where: { releaseId_code: { releaseId: await releaseIdFor(firstReleaseKey), code: 'CS100001' } },
    });
    const failingDir = writeSources({
      areas: [...DEFAULT_AREAS, areaRow({ TRDAR_CD: '3110004', TRDAR_CD_N: 'TestArea4' })],
      sales2025: DEFAULT_SALES_2025.map((row) => ({ ...row, industryName: 'ChangedFailedReleaseName' })),
      stores2025: DEFAULT_STORES_2025.map((row) => ({ ...row, industryName: 'ChangedFailedReleaseName' })),
    });
    await expect(
      loadMarketRelease({
        sourceDir: failingDir,
        prisma: db(),
        allowUnverifiedSourceForTests: true,
        log: () => {},
        hooks: {
          beforeActivate: () => {
            throw new Error('의도적으로 활성화 직전에 실패시킵니다.');
          },
        },
      }),
    ).rejects.toThrow('의도적으로 활성화 직전에 실패시킵니다.');

    const active = await db().marketRelease.findFirst({ where: { status: 'ACTIVE' } });
    expect(active?.releaseKey).toBe(firstReleaseKey);

    const failed = await db().marketRelease.findFirst({ where: { status: 'FAILED', createdAt: { gte: startedAt } } });
    expect(failed).not.toBeNull();
    expect(failed?.failureReason).toContain('의도적으로');
    expect(await db().marketArea.count({ where: { releaseId: failed?.id ?? '' } })).toBe(0);
    expect(await db().marketQuarterly.count({ where: { releaseId: failed?.id ?? '' } })).toBe(0);
    expect(await db().industry.count({ where: { releaseId: failed?.id ?? '' } })).toBe(0);

    const activeIndustryAfter = await db().industry.findUnique({
      where: { releaseId_code: { releaseId: await releaseIdFor(firstReleaseKey), code: 'CS100001' } },
    });
    expect(activeIndustryAfter?.sourceName).toBe(activeIndustryBefore?.sourceName);

    const stillServed = await prismaSummary('3110001', 'CS100001');
    expect(stillServed.availableQuarters).toHaveLength(2);
    const areaCount = await db().marketArea.count({ where: { releaseId: await releaseIdFor(firstReleaseKey) } });
    expect(areaCount).toBe(3);
  }, 120000);

  async function releaseIdFor(releaseKey: string): Promise<string> {
    const release = await db().marketRelease.findUnique({ where: { releaseKey }, select: { id: true } });
    if (!release) throw new Error(`릴리스를 찾지 못했습니다: ${releaseKey}`);
    return release.id;
  }

  async function releaseRowCounts(releaseKey: string) {
    const releaseId = await releaseIdFor(releaseKey);
    const [areaCount, quarterlyCount, salesCount] = await Promise.all([
      db().marketArea.count({ where: { releaseId } }),
      db().marketQuarterly.count({ where: { releaseId } }),
      db().marketQuarterly.count({ where: { releaseId, salesAmount: { not: null } } }),
    ]);
    return { areaCount, quarterlyCount, salesCount };
  }

  async function prismaAreas(districtCode: string) {
    const outcome = await listMarketAreas(db(), districtCode);
    if (outcome.kind !== 'OK') throw new Error(`상권 목록 조회 실패: ${outcome.kind}`);
    return outcome.payload;
  }

  async function prismaSummary(areaCode: string, industryCode: string) {
    const outcome = await getMarketSummary(db(), { areaCode, industryCode });
    if (outcome.kind !== 'OK') throw new Error(`요약 조회 실패: ${outcome.kind}`);
    return outcome.payload;
  }
});
