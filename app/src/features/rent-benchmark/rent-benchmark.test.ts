import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { SEOUL_DISTRICTS } from '../funding/districts.ts';
import { areaInSquareMeters, monthlyRentReferenceWon, percentLabel, wonPerSquareMeter } from './estimate.ts';
import { loadRentBenchmarks, parseRentTable, readRentSources, validateRentObservations } from './loader.ts';
import { RentBenchmarkError, type FetchLike } from './reb-api.ts';
import { getRentBenchmarks } from './read.ts';
import { districtsForRegion, REGION_DISTRICTS } from './regions.ts';
import { rentBenchmarkQuerySchema } from './schema.ts';
import { REB_RENT_TABLES, type RebTable } from './types.ts';

const KEY = 'REBTESTKEY%2Fabc';
type Row = Record<string, unknown>;

const QUARTERS = ['202501', '202502'];
const REGIONS = ['서울', '서울>강남', '서울>강남>테헤란로', '서울>기타>뚝섬'];
const FLOORS = ['지하1층', '1층', '2층'];

function tableRows(table: RebTable): Row[] {
  const rows: Row[] = [];
  const base = { STATBL_ID: table.id, DTACYCLE_CD: 'QY', ITM_ID: 100001, UI_NM: table.unit };
  for (const quarter of QUARTERS) {
    const offset = quarter === '202502' ? 1 : 0;
    const regions = [...REGIONS, '부산>서면'];
    regions.forEach((path, regionIndex) => {
      if (table.metric === 'FLOOR_RENT') {
        FLOORS.forEach((floor, floorIndex) => {
          const value =
            floorIndex === 0 && path === '서울>기타>뚝섬' ? null : 20 + regionIndex * 10 + floorIndex + offset;
          rows.push({
            ...base,
            WRTTIME_IDTFR_ID: quarter,
            GRP_FULLNM: path,
            CLS_NM: floor,
            CLS_FULLNM: floor,
            ITM_NM: '임대료',
            DTA_VAL: value,
          });
          rows.push({
            ...base,
            WRTTIME_IDTFR_ID: quarter,
            GRP_FULLNM: path,
            CLS_NM: floor,
            CLS_FULLNM: floor,
            ITM_NM: '효용비율',
            UI_NM: '%',
            DTA_VAL: 100,
          });
        });
      } else {
        const value = table.metric === 'VACANCY_RATE' ? 10.25 + regionIndex : 50.1234567 + regionIndex + offset;
        rows.push({
          ...base,
          WRTTIME_IDTFR_ID: quarter,
          GRP_FULLNM: null,
          CLS_FULLNM: path,
          CLS_NM: path.split('>').at(-1),
          ITM_NM: table.item,
          DTA_VAL: value,
        });
      }
    });
  }
  return rows;
}

type ApiData = { list: Row[]; tables: Record<string, Row[]> };

function defaultData(): ApiData {
  return {
    list: REB_RENT_TABLES.map((table) => ({ STATBL_ID: table.id, STATBL_NM: table.name })),
    tables: Object.fromEntries(REB_RENT_TABLES.map((table) => [table.id, tableRows(table)])),
  };
}

function reply(body: unknown) {
  return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
}

function page(service: string, rows: Row[], url: URL) {
  const index = Number(url.searchParams.get('pIndex'));
  const size = Number(url.searchParams.get('pSize'));
  return reply({
    [service]: [
      { head: [{ list_total_count: rows.length }, { RESULT: { CODE: 'INFO-000', MESSAGE: '정상 처리되었습니다.' } }] },
      { row: rows.slice((index - 1) * size, index * size) },
    ],
  });
}

function fakeApi(data: ApiData) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (raw) => {
    calls.push(raw);
    const url = new URL(raw);
    if (url.pathname.endsWith('/SttsApiTbl.do')) return page('SttsApiTbl', data.list, url);
    const rows = data.tables[url.searchParams.get('STATBL_ID') ?? ''];
    if (!rows) return reply({ RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } });
    return page('SttsApiTblData', rows, url);
  };
  return { fetchImpl, calls };
}

const readOptions = (data: ApiData = defaultData()) => ({
  apiKey: KEY,
  fetchImpl: fakeApi(data).fetchImpl,
  pageSize: 7,
  retryDelayMs: 0,
  now: new Date('2026-09-24T00:00:00.000Z'),
});

async function expectRentError(run: () => unknown): Promise<RentBenchmarkError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RentBenchmarkError) return error;
    throw error;
  }
  throw new Error('RentBenchmarkError가 발생하지 않았습니다.');
}

const floorTable = REB_RENT_TABLES.find(
  (table) => table.metric === 'FLOOR_RENT' && table.buildingType === 'SMALL_RETAIL',
);
const rentTable = REB_RENT_TABLES.find((table) => table.metric === 'RENT' && table.buildingType === 'SMALL_RETAIL');
if (!floorTable || !rentTable) throw new Error('테스트 표 정의가 없습니다.');

describe('임대료 환산', () => {
  it('평을 정의값(400/121㎡)으로 바꾸고 원 단위에서 한 번만 반올림한다', () => {
    expect(areaInSquareMeters({ value: '10', unit: 'PYEONG' })?.toFixed(6)).toBe('33.057851');
    expect(wonPerSquareMeter('91.3697597973057')).toBe('91370');
    expect(monthlyRentReferenceWon('91.3697597973057', { value: '10', unit: 'PYEONG' })).toBe('3020488');
    expect(monthlyRentReferenceWon('80.5', { value: '33', unit: 'SQUARE_METERS' })).toBe('2656500');
    expect(wonPerSquareMeter('0.0005')).toBe('1');
    expect(percentLabel('16.2917295944819')).toBe('16.3');
  });

  it('값이나 면적이 없으면 0이 아니라 null이다', () => {
    expect(wonPerSquareMeter(null)).toBeNull();
    expect(monthlyRentReferenceWon(null, { value: '10', unit: 'PYEONG' })).toBeNull();
    expect(monthlyRentReferenceWon('50', { value: '', unit: 'PYEONG' })).toBeNull();
    expect(monthlyRentReferenceWon('50', { value: '0', unit: 'SQUARE_METERS' })).toBeNull();
  });
});

describe('조사 상권과 자치구 연결', () => {
  it('서울 자치구 코드만 쓰고, 조사 상권에만 연결한다', () => {
    const codes = new Set(SEOUL_DISTRICTS.map((district) => district.code));
    for (const districts of Object.values(REGION_DISTRICTS)) {
      expect(districts.length).toBeGreaterThan(0);
      for (const code of districts) expect(codes.has(code)).toBe(true);
    }
    expect(districtsForRegion('서울>기타>뚝섬')).toEqual(['11200']);
    expect(districtsForRegion('서울>강남')).toEqual([]);
    expect(districtsForRegion('서울')).toEqual([]);
    expect(districtsForRegion('부산>서면>서면')).toEqual([]);
  });

  it('조회 조건은 상가 유형과 서울 자치구 코드만 받는다', () => {
    expect(rentBenchmarkQuerySchema.safeParse({ buildingType: 'SMALL_RETAIL', districtCode: '11200' }).success).toBe(
      true,
    );
    expect(rentBenchmarkQuerySchema.safeParse({ buildingType: 'SMALL_RETAIL', districtCode: null }).success).toBe(true);
    expect(rentBenchmarkQuerySchema.safeParse({ buildingType: 'SMALL_RETAIL', districtCode: '99999' }).success).toBe(
      false,
    );
    expect(rentBenchmarkQuerySchema.safeParse({ buildingType: 'OFFICE', districtCode: null }).success).toBe(false);
  });
});

describe('부동산원 표 해석', () => {
  it('서울 행만 남기고, 층별 표의 효용비율은 건너뛰며, 빈 값은 null로 둔다', () => {
    const rows = parseRentTable(floorTable, tableRows(floorTable));
    expect(rows).toHaveLength(QUARTERS.length * REGIONS.length * FLOORS.length);
    expect(rows.every((row) => row.regionPath.startsWith('서울'))).toBe(true);
    const basement = rows.find((row) => row.regionPath === '서울>기타>뚝섬' && row.floor === 'B1');
    expect(basement).toMatchObject({ value: null, quarter: '20251', regionName: '뚝섬', regionLevel: 3 });
    const regionRows = parseRentTable(rentTable, tableRows(rentTable));
    expect(regionRows.find((row) => row.regionPath === '서울')).toMatchObject({ floor: 'NONE', value: '50.1234567' });
  });

  it('모르는 단위·층·분기·음수·100% 초과 공실률은 적재하지 않는다', async () => {
    const good = tableRows(rentTable)[0];
    for (const bad of [{ UI_NM: '원/㎡' }, { WRTTIME_IDTFR_ID: '2025Q1' }, { DTA_VAL: -1 }, { DTA_VAL: 'n/a' }]) {
      expect((await expectRentError(() => parseRentTable(rentTable, [{ ...good, ...bad }]))).code).toBe('INVALID_ROW');
    }
    const floorRow = tableRows(floorTable)[0];
    expect((await expectRentError(() => parseRentTable(floorTable, [{ ...floorRow, CLS_NM: '옥상' }]))).code).toBe(
      'INVALID_ROW',
    );
    const vacancy = REB_RENT_TABLES.find((table) => table.metric === 'VACANCY_RATE');
    if (!vacancy) throw new Error('공실률 표 정의가 없습니다.');
    const vacancyRow = tableRows(vacancy)[0];
    expect((await expectRentError(() => parseRentTable(vacancy, [{ ...vacancyRow, DTA_VAL: 100.1 }]))).code).toBe(
      'INVALID_ROW',
    );
  });

  it('표마다 분기나 지역 구성이 다르면 멈춘다', async () => {
    const tables = REB_RENT_TABLES.map((table) => ({ table, observations: parseRentTable(table, tableRows(table)) }));
    expect(validateRentObservations(tables)).toMatchObject({
      basisStart: '20251',
      basisEnd: '20252',
      unmappedRegions: [],
    });

    const missingQuarter = tables.map((entry, index) =>
      index === 0 ? { ...entry, observations: entry.observations.filter((row) => row.quarter !== '20252') } : entry,
    );
    expect((await expectRentError(() => validateRentObservations(missingQuarter))).code).toBe('QUARTER_MISMATCH');

    const missingRegion = tables.map((entry, index) =>
      index === 0
        ? { ...entry, observations: entry.observations.filter((row) => row.regionPath !== '서울>기타>뚝섬') }
        : entry,
    );
    expect((await expectRentError(() => validateRentObservations(missingRegion))).code).toBe('REGION_MISMATCH');

    const duplicated = tables.map((entry, index) =>
      index === 0 ? { ...entry, observations: [...entry.observations, entry.observations[0]] } : entry,
    );
    expect((await expectRentError(() => validateRentObservations(duplicated))).code).toBe('DUPLICATE_KEY');
  });
});

describe('부동산원 Open API 적재 원본', () => {
  it('페이지를 나눠 받고, 행 순서와 무관한 릴리스 키를 만든다', async () => {
    const api = fakeApi(defaultData());
    const parsed = await readRentSources({ ...readOptions(), fetchImpl: api.fetchImpl });
    expect(parsed.releaseKey).toMatch(/^reb-rent-seoul-2025q1-2025q2-[0-9a-f]{12}$/);
    expect(parsed.basisPeriodLabel).toBe('2025년 1분기~2분기');
    expect(parsed.sourceTables).toHaveLength(REB_RENT_TABLES.length);
    expect(parsed.checks.map((check) => check.name)).toEqual([
      '서울 행',
      '분기 일치',
      '중복 키 0',
      '지역 일치',
      '자치구 연결',
    ]);
    expect(api.calls.length).toBeGreaterThan(REB_RENT_TABLES.length + 1);

    const reversed = defaultData();
    for (const id of Object.keys(reversed.tables)) reversed.tables[id].reverse();
    expect((await readRentSources(readOptions(reversed))).releaseKey).toBe(parsed.releaseKey);

    const changed = defaultData();
    changed.tables[rentTable.id][0] = { ...changed.tables[rentTable.id][0], DTA_VAL: 51 };
    expect((await readRentSources(readOptions(changed))).releaseKey).not.toBe(parsed.releaseKey);
  });

  it('같은 ID가 다른 표를 가리키면 적재하지 않는다', async () => {
    const data = defaultData();
    data.list[0] = { ...data.list[0], STATBL_NM: '다른 표' };
    expect((await expectRentError(() => readRentSources(readOptions(data)))).code).toBe('TABLE_MISMATCH');
  });

  it('인증키 오류는 재시도하지 않고, 오류에 키를 남기지 않는다', async () => {
    let calls = 0;
    const invalid: FetchLike = () => {
      calls += 1;
      return reply({
        RESULT: { CODE: 'ERROR-290', MESSAGE: `인증키가 유효하지 않습니다. ${KEY} ${decodeURIComponent(KEY)}` },
      });
    };
    const error = await expectRentError(() => readRentSources({ ...readOptions(), fetchImpl: invalid }));
    expect(error.code).toBe('SOURCE_API_ERROR');
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain(decodeURIComponent(KEY));
    expect(calls).toBe(1);
  });

  it('받는 도중 전체 건수가 바뀌면 적재하지 않는다', async () => {
    const data = defaultData();
    const api = fakeApi(data);
    let tableCalls = 0;
    const shifting: FetchLike = (raw) => {
      const url = new URL(raw);
      if (url.pathname.endsWith('/SttsApiTblData.do') && ++tableCalls === 2) data.tables[rentTable.id].push({});
      return api.fetchImpl(raw);
    };
    expect((await expectRentError(() => readRentSources({ ...readOptions(data), fetchImpl: shifting }))).code).toBe(
      'INCOMPLETE_SOURCE',
    );
  });
});

// 가짜 API로 합성 릴리스를 전용 테스트 DB에 적재하고, 끝나면 지우고 이전 ACTIVE를 되돌린다.
describe.skipIf(!process.env.TEST_DATABASE_URL)('부동산원 임대료 릴리스 적재(PostgreSQL)', () => {
  let client: PrismaClient | null = null;
  let previousActiveId: string | null = null;
  let startedAt = new Date(0);
  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    startedAt = new Date();
    previousActiveId = (await db().rentBenchmarkRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;
  });

  afterAll(async () => {
    await db().rentBenchmarkRelease.deleteMany({ where: { createdAt: { gte: startedAt } } });
    if (previousActiveId) {
      const previous = await db().rentBenchmarkRelease.findUnique({ where: { id: previousActiveId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().rentBenchmarkRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
        await db().rentBenchmarkRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
  });

  it('릴리스를 활성화해 조사 지역별 값을 돌려주고, 같은 내용은 다시 적재하지 않는다', async () => {
    const report = await loadRentBenchmarks({ ...readOptions(), prisma: db() });
    expect(report.outcome).toBe('ACTIVATED');
    expect(report.observationCount).toBe(QUARTERS.length * REGIONS.length * (3 + 3 + 3 * FLOORS.length));

    const outcome = await getRentBenchmarks(db(), { buildingType: 'SMALL_RETAIL', districtCode: '11200' });
    if (outcome.kind !== 'OK') throw new Error(outcome.kind);
    const { payload } = outcome;
    expect(payload.source.releaseKey).toBe(report.releaseKey);
    expect(payload.source.latestQuarter).toBe('20252');
    expect(payload.district).toEqual({ code: '11200', name: '성동구', regionPaths: ['서울>기타>뚝섬'] });
    expect(payload.regions.map((region) => region.path)).toEqual([
      '서울',
      '서울>강남',
      '서울>강남>테헤란로',
      '서울>기타>뚝섬',
    ]);
    const ttukseom = payload.regions.find((region) => region.path === '서울>기타>뚝섬');
    expect(ttukseom?.latest).toMatchObject({ rentPerSquareMeterWon: '54123', vacancyRatePercent: '13.3' });
    expect(ttukseom?.latest.floors.map((floor) => [floor.floor, floor.rentPerSquareMeterWon])).toEqual([
      ['B1', null],
      ['1F', '52000'],
      ['2F', '53000'],
    ]);
    expect(ttukseom?.trend.map((point) => point.rentPerSquareMeterWon)).toEqual(['53123', '54123']);

    const again = await loadRentBenchmarks({ ...readOptions(), prisma: db() });
    expect(again.outcome).toBe('ALREADY_ACTIVE');
    expect(await db().rentBenchmarkRelease.count({ where: { releaseKey: report.releaseKey } })).toBe(1);
  }, 120000);
});
