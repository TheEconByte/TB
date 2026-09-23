import type { Prisma, PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from '../market/checksum.ts';
import { basisPeriodLabel, quartersBetween } from '../market/quarter.ts';
import { canonicalRowsHash } from '../market/seoul-api.ts';
import { createRebApiClient, RentBenchmarkError, type FetchLike, type RebRow } from './reb-api.ts';
import { districtsForRegion } from './regions.ts';
import {
  IGNORED_FLOOR_ITEMS,
  REB_RENT_TABLES,
  RENT_BENCHMARK_SCHEMA_VERSION,
  RENT_BENCHMARK_SOURCE_URL,
  SOURCE_FLOOR_NAMES,
  type RebTable,
  type RentObservationRecord,
  type RentSourceTableRecord,
} from './types.ts';

export { RentBenchmarkError } from './reb-api.ts';

// 원본 표의 행을 해시할 때 쓰는 필드. 행 순서와 무관한 내용 해시를 출처로 남긴다.
const SOURCE_HASH_FIELDS = ['WRTTIME_IDTFR_ID', 'GRP_FULLNM', 'CLS_FULLNM', 'ITM_NM', 'UI_NM', 'DTA_VAL'] as const;

export type RentCheck = { name: string; detail: string };

export type ParsedRentSources = {
  releaseKey: string;
  basisStart: string;
  basisEnd: string;
  basisPeriodLabel: string;
  retrievedAt: Date;
  observations: RentObservationRecord[];
  sourceTables: RentSourceTableRecord[];
  checks: RentCheck[];
  unmappedRegions: string[];
};

export type ReadRentSourcesOptions = {
  apiKey: string;
  fetchImpl?: FetchLike;
  pageSize?: number;
  concurrency?: number;
  retryDelayMs?: number;
  now?: Date;
  log?: (message: string) => void;
};

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function isSeoul(path: string): boolean {
  return path === '서울' || path.startsWith('서울>');
}

// 2024년 3분기는 원본에서 202403이다. 상권 데이터와 같은 20243 형식으로 바꾼다.
function sourceQuarter(value: unknown): string | null {
  const match = /^(\d{4})0([1-4])$/.exec(text(value));
  return match ? `${match[1]}${match[2]}` : null;
}

function sourceValue(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/.test(value.trim())) return value.trim();
  return undefined;
}

function invalidRow(table: RebTable, index: number, reason: string): never {
  throw new RentBenchmarkError('INVALID_ROW', `${table.id}(${table.name}) ${index + 1}번째 행: ${reason}`);
}

// 서울 행만 관측값으로 바꾼다. 알 수 없는 항목·단위·분기·층·값은 추측하지 않고 적재를 멈춘다.
export function parseRentTable(table: RebTable, rows: readonly RebRow[]): RentObservationRecord[] {
  const observations: RentObservationRecord[] = [];
  rows.forEach((row, index) => {
    const floorTable = table.metric === 'FLOOR_RENT';
    const regionPath = text(floorTable ? row.GRP_FULLNM : row.CLS_FULLNM);
    if (!isSeoul(regionPath)) return;
    const item = text(row.ITM_NM);
    if (floorTable && IGNORED_FLOOR_ITEMS.has(item)) return;
    if (item !== table.item) invalidRow(table, index, `항목 '${item}'은 기대한 '${table.item}'이 아닙니다.`);
    const unit = text(row.UI_NM);
    if (unit !== table.unit) invalidRow(table, index, `단위 '${unit}'은 기대한 '${table.unit}'이 아닙니다.`);
    const quarter = sourceQuarter(row.WRTTIME_IDTFR_ID);
    if (!quarter) invalidRow(table, index, `분기 '${text(row.WRTTIME_IDTFR_ID)}'를 해석할 수 없습니다.`);
    const floorName = floorTable ? text(row.CLS_NM) : '';
    const floor = floorTable ? SOURCE_FLOOR_NAMES[floorName] : 'NONE';
    if (!floor) invalidRow(table, index, `층 '${floorName}'을 해석할 수 없습니다.`);
    const value = sourceValue(row.DTA_VAL);
    if (value === undefined) invalidRow(table, index, `값 '${String(row.DTA_VAL)}'이 숫자가 아닙니다.`);
    if (value !== null && Number(value) < 0) invalidRow(table, index, `값 ${value}이 음수입니다.`);
    if (value !== null && table.metric === 'VACANCY_RATE' && Number(value) > 100)
      invalidRow(table, index, `공실률 ${value}%가 100을 넘습니다.`);
    const parts = regionPath.split('>');
    observations.push({
      buildingType: table.buildingType,
      metric: table.metric,
      quarter,
      regionPath,
      regionName: parts[parts.length - 1],
      regionLevel: parts.length,
      floor,
      value,
      unit,
      sourceTableId: table.id,
    });
  });
  return observations;
}

function observationKey(row: RentObservationRecord): string {
  return [row.buildingType, row.metric, row.quarter, row.regionPath, row.floor].join('|');
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function releaseCode(quarter: string): string {
  return `${quarter.slice(0, 4)}q${quarter.slice(4)}`;
}

// 적재 전 검증. 하나라도 어긋나면 예외로 멈추고, 통과한 검사는 릴리스 요약에 남긴다.
export function validateRentObservations(
  tables: ReadonlyArray<{ table: RebTable; observations: readonly RentObservationRecord[] }>,
): { checks: RentCheck[]; basisStart: string; basisEnd: string; unmappedRegions: string[] } {
  const checks: RentCheck[] = [];
  const empty = tables.filter((entry) => entry.observations.length === 0).map((entry) => entry.table.id);
  if (empty.length > 0)
    throw new RentBenchmarkError('EMPTY_SOURCE', `서울 행이 없는 표가 있습니다: ${empty.join(', ')}`);
  checks.push({ name: '서울 행', detail: `표 ${tables.length}개 모두 서울 행이 있습니다.` });

  const quarterSets = tables.map((entry) => new Set(entry.observations.map((row) => row.quarter)));
  const quarters = [...quarterSets[0]].sort();
  if (!quarterSets.every((set) => sameSet(set, quarterSets[0])))
    throw new RentBenchmarkError('QUARTER_MISMATCH', '표마다 서울 분기 구성이 다릅니다.');
  const basisStart = quarters[0];
  const basisEnd = quarters[quarters.length - 1];
  if (quartersBetween(basisStart, basisEnd).length !== quarters.length)
    throw new RentBenchmarkError('QUARTER_MISMATCH', `분기가 연속되지 않습니다: ${quarters.join(', ')}`);
  checks.push({
    name: '분기 일치',
    detail: `모든 표가 ${basisPeriodLabel(basisStart, basisEnd)} ${quarters.length}개 분기입니다.`,
  });

  const keys = new Set<string>();
  for (const entry of tables) {
    for (const row of entry.observations) {
      const key = observationKey(row);
      if (keys.has(key)) throw new RentBenchmarkError('DUPLICATE_KEY', `중복 관측 키: ${key}`);
      keys.add(key);
    }
  }
  checks.push({ name: '중복 키 0', detail: `관측값 ${keys.size}건의 키가 모두 다릅니다.` });

  const buildingTypes = [...new Set(tables.map((entry) => entry.table.buildingType))];
  for (const buildingType of buildingTypes) {
    const regionSets = tables
      .filter((entry) => entry.table.buildingType === buildingType)
      .map((entry) => new Set(entry.observations.map((row) => row.regionPath)));
    if (!regionSets.every((set) => sameSet(set, regionSets[0])))
      throw new RentBenchmarkError('REGION_MISMATCH', `${buildingType}의 임대료·층별·공실률 표 지역 구성이 다릅니다.`);
  }
  checks.push({ name: '지역 일치', detail: '상가 유형마다 임대료·층별 임대료·공실률 표의 서울 지역이 같습니다.' });

  const localRegions = [...new Set(tables.flatMap((entry) => entry.observations.map((row) => row.regionPath)))].filter(
    (path) => path.split('>').length === 3,
  );
  const unmappedRegions = localRegions.filter((path) => districtsForRegion(path).length === 0).sort();
  checks.push({
    name: '자치구 연결',
    detail: `조사 상권 ${localRegions.length}곳 중 ${localRegions.length - unmappedRegions.length}곳을 자치구와 연결했습니다.`,
  });
  return { checks, basisStart, basisEnd, unmappedRegions };
}

export async function readRentSources(options: ReadRentSourcesOptions): Promise<ParsedRentSources> {
  const log = options.log ?? (() => {});
  const client = createRebApiClient({
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    pageSize: options.pageSize,
    concurrency: options.concurrency,
    retryDelayMs: options.retryDelayMs,
  });
  const retrievedAt = options.now ?? new Date();

  // 같은 ID가 다른 표를 가리키게 되면 단위·정의가 바뀐 것일 수 있으므로 이름부터 대조한다.
  const list = await client.fetchTableList();
  const names = new Map(list.rows.map((row) => [text(row.STATBL_ID), text(row.STATBL_NM)]));
  for (const table of REB_RENT_TABLES) {
    const actual = names.get(table.id);
    if (actual !== table.name)
      throw new RentBenchmarkError(
        'TABLE_MISMATCH',
        `${table.id}의 이름이 '${actual ?? '없음'}'입니다. 기대한 이름은 '${table.name}'입니다.`,
      );
  }

  const tables: Array<{ table: RebTable; observations: RentObservationRecord[] }> = [];
  const sourceTables: RentSourceTableRecord[] = [];
  for (const table of REB_RENT_TABLES) {
    const result = await client.fetchTable(table.id);
    const observations = parseRentTable(table, result.rows);
    log(`${table.name}: ${result.total}행 중 서울 ${observations.length}건`);
    tables.push({ table, observations });
    sourceTables.push({
      id: table.id,
      name: table.name,
      buildingType: table.buildingType,
      metric: table.metric,
      totalRows: result.total,
      seoulRows: observations.length,
      sha256: canonicalRowsHash(result.rows, SOURCE_HASH_FIELDS),
    });
  }

  const validation = validateRentObservations(tables);
  const observations = tables.flatMap((entry) => entry.observations);
  const lines = observations.map((row) =>
    JSON.stringify([row.buildingType, row.metric, row.quarter, row.regionPath, row.floor, row.value, row.unit]),
  );
  lines.sort();
  const contentHash = sha256Hex(lines.join('\n'));
  return {
    releaseKey: `reb-rent-seoul-${releaseCode(validation.basisStart)}-${releaseCode(validation.basisEnd)}-${contentHash.slice(0, 12)}`,
    basisStart: validation.basisStart,
    basisEnd: validation.basisEnd,
    basisPeriodLabel: basisPeriodLabel(validation.basisStart, validation.basisEnd),
    retrievedAt,
    observations,
    sourceTables,
    checks: validation.checks,
    unmappedRegions: validation.unmappedRegions,
  };
}

export type RentLoadReport = {
  outcome: 'ACTIVATED' | 'ALREADY_ACTIVE';
  releaseKey: string;
  basisPeriodLabel: string;
  observationCount: number;
  checks: RentCheck[];
  unmappedRegions: string[];
};

async function markFailed(prisma: PrismaClient, releaseId: string, error: unknown) {
  await prisma.rentBenchmarkObservation.deleteMany({ where: { releaseId } });
  await prisma.rentBenchmarkRelease.update({
    where: { id: releaseId },
    data: {
      status: 'FAILED',
      failedAt: new Date(),
      failureReason: (error instanceof Error ? error.message : String(error)).slice(0, 2000),
    },
  });
}

export async function loadRentBenchmarks(
  options: ReadRentSourcesOptions & { prisma: PrismaClient },
): Promise<RentLoadReport> {
  const parsed = await readRentSources(options);
  const { prisma } = options;
  const base = {
    releaseKey: parsed.releaseKey,
    basisPeriodLabel: parsed.basisPeriodLabel,
    observationCount: parsed.observations.length,
    checks: parsed.checks,
    unmappedRegions: parsed.unmappedRegions,
  };
  const existing = await prisma.rentBenchmarkRelease.findUnique({ where: { releaseKey: parsed.releaseKey } });
  if (existing?.status === 'ACTIVE') return { outcome: 'ALREADY_ACTIVE', ...base };
  if (existing) await prisma.rentBenchmarkRelease.delete({ where: { id: existing.id } });
  const release = await prisma.rentBenchmarkRelease.create({
    data: {
      releaseKey: parsed.releaseKey,
      schemaVersion: RENT_BENCHMARK_SCHEMA_VERSION,
      sourceUrl: RENT_BENCHMARK_SOURCE_URL,
      basisPeriod: `${parsed.basisStart}-${parsed.basisEnd}`,
      basisPeriodLabel: parsed.basisPeriodLabel,
      retrievedAt: parsed.retrievedAt,
      sourceTables: parsed.sourceTables as unknown as Prisma.InputJsonValue,
      validationSummary: {
        checks: parsed.checks,
        unmappedRegions: parsed.unmappedRegions,
      } as unknown as Prisma.InputJsonValue,
      observationCount: parsed.observations.length,
    },
  });
  try {
    const chunkSize = 2000;
    for (let index = 0; index < parsed.observations.length; index += chunkSize) {
      await prisma.rentBenchmarkObservation.createMany({
        data: parsed.observations.slice(index, index + chunkSize).map((row) => ({ ...row, releaseId: release.id })),
      });
    }
    const persisted = await prisma.rentBenchmarkObservation.count({ where: { releaseId: release.id } });
    if (persisted !== parsed.observations.length)
      throw new RentBenchmarkError(
        'DB_VERIFICATION',
        `적재 ${persisted}건이 검증값 ${parsed.observations.length}건과 다릅니다.`,
      );
    await prisma.$transaction([
      prisma.rentBenchmarkRelease.updateMany({
        where: { status: 'ACTIVE', id: { not: release.id } },
        data: { status: 'SUPERSEDED' },
      }),
      prisma.rentBenchmarkRelease.update({
        where: { id: release.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      }),
    ]);
  } catch (error) {
    await markFailed(prisma, release.id, error);
    throw error;
  }
  return { outcome: 'ACTIVATED', ...base };
}
