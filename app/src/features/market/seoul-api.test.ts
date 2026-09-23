import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { AREA_API_FIELD_NAMES, SALES_API_FIELDS, STORES_API_FIELDS } from './headers.ts';
import { loadMarketReleaseFromApi, readMarketApiSources } from './loader.ts';
import { getMarketSummary, listMarketAreas } from './read.ts';
import { apiCell, createSeoulApiClient, findLatestQuarter, secretMasker, type FetchLike } from './seoul-api.ts';
import { MarketSourceError } from './validation.ts';

const KEY = 'TESTKEY0123456789abcdef';
type Row = Record<string, unknown>;

function salesRow(overrides: Row): Row {
  const row: Row = Object.fromEntries(Object.keys(SALES_API_FIELDS).map((field) => [field, 0]));
  return {
    ...row,
    TRDAR_SE_CD: 'A',
    TRDAR_SE_CD_NM: '골목상권',
    TRDAR_CD_NM: `TestArea${String(overrides.TRDAR_CD ?? '').slice(-1)}`,
    SVC_INDUTY_CD_NM: 'Industry',
    THSMON_SELNG_CO: 10,
    ...overrides,
  };
}

function storeRow(overrides: Row): Row {
  const row: Row = Object.fromEntries(Object.keys(STORES_API_FIELDS).map((field) => [field, 0]));
  return {
    ...row,
    TRDAR_SE_CD: 'A',
    TRDAR_SE_CD_NM: '골목상권',
    TRDAR_CD_NM: `TestArea${String(overrides.TRDAR_CD ?? '').slice(-1)}`,
    SVC_INDUTY_CD_NM: 'Industry',
    OPBIZ_RT: 0.5,
    CLSBIZ_RT: 0.5,
    ...overrides,
  };
}

function areaRow(code: string): Row {
  const row: Row = Object.fromEntries(AREA_API_FIELD_NAMES.map((field) => [field, 0]));
  return {
    ...row,
    TRDAR_SE_CD: 'A',
    TRDAR_SE_CD_NM: '골목상권',
    TRDAR_CD: code,
    TRDAR_CD_NM: `TestArea${code.slice(-1)}`,
    SIGNGU_CD: '11200',
    SIGNGU_CD_NM: '성동구',
    ADSTRD_CD: '11200520',
    ADSTRD_CD_NM: '성수1가1동',
  };
}

function store(quarter: string, code: string, industry: string, storeCount: number, franchise = 0): Row {
  return storeRow({
    STDR_YYQU_CD: quarter,
    TRDAR_CD: code,
    SVC_INDUTY_CD: industry,
    STOR_CO: storeCount,
    FRC_STOR_CO: franchise,
    SIMILR_INDUTY_STOR_CO: storeCount + franchise,
  });
}

type ApiData = { areas: Row[]; sales: Row[]; stores: Row[] };

function defaultData(): ApiData {
  return {
    areas: ['3110001', '3110002', '3110003'].map(areaRow),
    sales: [
      salesRow({ STDR_YYQU_CD: '20241', TRDAR_CD: '3110001', SVC_INDUTY_CD: 'CS100001', THSMON_SELNG_AMT: 123456789 }),
      salesRow({ STDR_YYQU_CD: '20241', TRDAR_CD: '3110001', SVC_INDUTY_CD: 'CS100002', THSMON_SELNG_AMT: 5 }),
      salesRow({ STDR_YYQU_CD: '20242', TRDAR_CD: '3110001', SVC_INDUTY_CD: 'CS100001', THSMON_SELNG_AMT: 200 }),
      salesRow({ STDR_YYQU_CD: '20242', TRDAR_CD: '3110001', SVC_INDUTY_CD: 'CS100010', THSMON_SELNG_AMT: 0 }),
    ],
    stores: [
      store('20241', '3110001', 'CS100001', 10, 3),
      store('20241', '3110001', 'CS100002', 4),
      store('20241', '3110002', 'CS100001', 7),
      store('20242', '3110001', 'CS100001', 11, 3),
      store('20242', '3110001', 'CS100010', 2),
    ],
  };
}

const SERVICE_DATA: Record<string, keyof ApiData> = {
  TbgisTrdarRelm: 'areas',
  VwsmTrdarSelngQq: 'sales',
  VwsmTrdarStorQq: 'stores',
};

function reply(body: unknown) {
  return Promise.resolve({ status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
}

function fakeApi(data: ApiData) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    calls.push(url);
    const match = /\/json\/(\w+)\/(\d+)\/(\d+)\/(\d*)$/.exec(url);
    if (!match) throw new Error(`예상하지 못한 URL: ${url}`);
    const [, service, start, end, quarter] = match;
    const key = SERVICE_DATA[service];
    if (!key) return reply({ RESULT: { CODE: 'ERROR-310', MESSAGE: '해당하는 서비스를 찾을 수 없습니다.' } });
    const rows = quarter ? data[key].filter((row) => row.STDR_YYQU_CD === quarter) : data[key];
    if (rows.length === 0) return reply({ RESULT: { CODE: 'INFO-200', MESSAGE: '해당하는 데이터가 없습니다.' } });
    return reply({
      [service]: {
        list_total_count: rows.length,
        RESULT: { CODE: 'INFO-000', MESSAGE: '정상 처리되었습니다' },
        row: rows.slice(Number(start) - 1, Number(end)),
      },
    });
  };
  return { fetchImpl, calls };
}

const readOptions = (data: ApiData = defaultData()) => ({
  apiKey: KEY,
  fromQuarter: '20241',
  toQuarter: '20242',
  fetchImpl: fakeApi(data).fetchImpl,
  pageSize: 2,
  retryDelayMs: 0,
  now: new Date('2026-09-23T00:00:00.000Z'),
});

async function expectSourceError(run: () => Promise<unknown>): Promise<MarketSourceError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MarketSourceError) return error;
    throw error;
  }
  throw new Error('MarketSourceError가 발생하지 않았습니다.');
}

describe('서울 Open API 클라이언트', () => {
  it('페이지를 나눠 전체 건수만큼 받는다', async () => {
    const api = fakeApi(defaultData());
    const client = createSeoulApiClient({ apiKey: KEY, fetchImpl: api.fetchImpl, pageSize: 2 });
    const result = await client.fetchAll('VwsmTrdarStorQq', '20241');
    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(3);
    expect(api.calls).toHaveLength(2);
  });

  it('자료 없음(INFO-200)은 빈 결과로 돌려준다', async () => {
    const client = createSeoulApiClient({ apiKey: KEY, fetchImpl: fakeApi(defaultData()).fetchImpl });
    expect((await client.fetchAll('VwsmTrdarSelngQq', '20253')).total).toBe(0);
  });

  it('서버 오류를 재시도하고, 끝내 실패해도 오류에 키를 남기지 않는다', async () => {
    let calls = 0;
    const failing: FetchLike = () => {
      calls += 1;
      return reply({ RESULT: { CODE: 'ERROR-500', MESSAGE: `서버 오류 ${KEY} ${encodeURIComponent(KEY)}` } });
    };
    const client = createSeoulApiClient({ apiKey: KEY, fetchImpl: failing, retries: 2, retryDelayMs: 0 });
    const error = await expectSourceError(() => client.fetchAll('TbgisTrdarRelm'));
    expect(error.code).toBe('SOURCE_API_ERROR');
    expect(error.message).not.toContain(KEY);
    expect(calls).toBe(3);
  });

  it('인증키 오류는 재시도하지 않고 바로 실패한다', async () => {
    let calls = 0;
    const invalid: FetchLike = () => {
      calls += 1;
      return reply({ RESULT: { CODE: 'INFO-100', MESSAGE: '인증키가 유효하지 않습니다.' } });
    };
    const client = createSeoulApiClient({ apiKey: KEY, fetchImpl: invalid, retryDelayMs: 0 });
    expect((await expectSourceError(() => client.fetchAll('TbgisTrdarRelm'))).code).toBe('SOURCE_API_ERROR');
    expect(calls).toBe(1);
  });

  it('받는 도중 전체 건수가 바뀌면 적재하지 않는다', async () => {
    let page = 0;
    const shifting: FetchLike = () => {
      page += 1;
      return reply({
        TbgisTrdarRelm: {
          list_total_count: page === 1 ? 3 : 4,
          RESULT: { CODE: 'INFO-000' },
          row: [areaRow('3110001'), areaRow('3110002')].slice(0, page === 1 ? 2 : 1),
        },
      });
    };
    const client = createSeoulApiClient({ apiKey: KEY, fetchImpl: shifting, pageSize: 2 });
    expect((await expectSourceError(() => client.fetchAll('TbgisTrdarRelm'))).code).toBe('INCOMPLETE_SOURCE');
  });

  it('매출과 점포가 모두 있는 최신 분기를 찾는다', async () => {
    const data = defaultData();
    const july2024 = new Date('2024-07-01T00:00:00.000Z');
    const client = createSeoulApiClient({ apiKey: KEY, fetchImpl: fakeApi(data).fetchImpl });
    expect(await findLatestQuarter(client, july2024)).toBe('20242');

    const withoutStores = { ...data, stores: data.stores.filter((row) => row.STDR_YYQU_CD !== '20242') };
    const partial = createSeoulApiClient({ apiKey: KEY, fetchImpl: fakeApi(withoutStores).fetchImpl });
    expect(await findLatestQuarter(partial, july2024)).toBe('20241');
  });

  it('키는 원문·인코딩·디코딩 형태 모두 가린다', () => {
    const encoded = 'ab%2Fcd%3D';
    const mask = secretMasker(encoded);
    expect(mask(`x ${encoded} y ab/cd= z`)).toBe('x *** y *** z');
  });

  it('정밀도를 잃는 큰 숫자는 원래 값처럼 넘기지 않는다', () => {
    expect(apiCell(184219542)).toBe('184219542');
    expect(apiCell(null)).toBe('');
    expect(apiCell(2 ** 60)).toMatch(/^UNSAFE:/);
  });
});

describe('서울 Open API 적재 원본', () => {
  it('파일 적재와 같은 규칙으로 분기 지표를 만든다', async () => {
    const parsed = await readMarketApiSources(readOptions());
    expect(parsed.stats.quarters).toEqual(['20241', '20242']);
    expect(parsed.quarterly).toHaveLength(4);
    expect(parsed.checks.every((check) => check.passed)).toBe(true);

    const first = parsed.quarterly.find((row) => row.quarter === '20241' && row.areaCode === '3110001');
    expect(first).toMatchObject({
      salesAmount: '123456789',
      salesCount: '10',
      storeCount: 10,
      similarIndustryStoreCount: 13,
    });
    expect(first?.salesBreakdownJson?.timeOfDay).toHaveLength(6);
    expect(parsed.quarterly.find((row) => row.industryCode === 'CS100010')?.salesAmount).toBe('0');
    expect(parsed.quarterly.find((row) => row.areaCode === '3110002')?.salesAmount).toBeNull();
    expect(parsed.quarterly.find((row) => row.industryCode === 'CS100002')).toBeUndefined();
    expect(parsed.industries.find((industry) => industry.code === 'CS100002')?.isSupported).toBe(false);

    expect(parsed.files.map((file) => file.file)).toEqual([
      'api:TbgisTrdarRelm',
      'api:VwsmTrdarSelngQq',
      'api:VwsmTrdarStorQq',
    ]);
    expect(parsed.files.map((file) => file.rowCount)).toEqual([3, 4, 5]);
    expect(parsed.release).toMatchObject({
      basisStart: '20241',
      basisEnd: '20242',
      basisPeriodLabel: '2024년 1분기~2분기',
    });
    expect(parsed.releaseKey).toMatch(/^seoul-market-2024q1-2024q2-[0-9a-f]{12}$/);
    expect(parsed.sourceQuarters.map((record) => `${record.service}:${record.quarter ?? '-'}`)).toEqual([
      'TbgisTrdarRelm:-',
      'VwsmTrdarSelngQq:20241',
      'VwsmTrdarStorQq:20241',
      'VwsmTrdarSelngQq:20242',
      'VwsmTrdarStorQq:20242',
    ]);
  });

  it('같은 내용을 다른 순서로 받아도 릴리스 키가 같고, 값이 바뀌면 달라진다', async () => {
    const base = await readMarketApiSources(readOptions());
    const data = defaultData();
    const reversed = {
      areas: [...data.areas].reverse(),
      sales: [...data.sales].reverse(),
      stores: [...data.stores].reverse(),
    };
    expect((await readMarketApiSources(readOptions(reversed))).releaseKey).toBe(base.releaseKey);

    const changed = defaultData();
    changed.sales[0] = { ...changed.sales[0], THSMON_SELNG_AMT: 123456790 };
    expect((await readMarketApiSources(readOptions(changed))).releaseKey).not.toBe(base.releaseKey);
  });

  it('점포 자료가 없는 매출, 기록과 다른 필드, 빈 분기를 거부한다', async () => {
    const missingStore = defaultData();
    missingStore.sales.push(
      salesRow({ STDR_YYQU_CD: '20242', TRDAR_CD: '3110003', SVC_INDUTY_CD: 'CS100001', THSMON_SELNG_AMT: 1 }),
    );
    expect(
      (await expectSourceError(() => readMarketApiSources(readOptions(missingStore)))).errorCounts?.JOIN_MISSING_STORES,
    ).toBe(1);

    const extraField = defaultData();
    extraField.sales[0] = { ...extraField.sales[0], NEW_FIELD: 1 };
    expect(
      (await expectSourceError(() => readMarketApiSources(readOptions(extraField)))).errorCounts?.UNEXPECTED_HEADER,
    ).toBe(1);

    const emptyQuarter = await expectSourceError(() => readMarketApiSources({ ...readOptions(), toQuarter: '20243' }));
    expect(emptyQuarter.errorCounts?.INCOMPLETE_SOURCE).toBe(2);
  });
});

// 가짜 API로 합성 릴리스를 전용 테스트 DB에 적재하고, 끝나면 지우고 이전 ACTIVE를 되돌린다.
describe.skipIf(!process.env.TEST_DATABASE_URL)('서울 Open API 릴리스 적재(PostgreSQL)', () => {
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
    previousActiveId = (await db().marketRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;
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

  it('API 릴리스를 활성화하고, 같은 내용을 다시 받으면 중복 적재하지 않는다', async () => {
    const report = await loadMarketReleaseFromApi({ ...readOptions(), prisma: db(), log: () => {} });
    expect(report.outcome).toBe('ACTIVATED');
    expect(report.areaCount).toBe(3);
    expect(report.quarterlyRowCount).toBe(4);

    const areas = await listMarketAreas(db(), '11200');
    if (areas.kind !== 'OK') throw new Error(areas.kind);
    expect(areas.payload.release.releaseKey).toBe(report.releaseKey);
    expect(areas.payload.release.basisPeriod).toBe('20241-20242');
    expect(areas.payload.release.sources.map((source) => source.fileName)).toEqual([
      'api:TbgisTrdarRelm',
      'api:VwsmTrdarSelngQq',
      'api:VwsmTrdarStorQq',
    ]);

    const summary = await getMarketSummary(db(), { areaCode: '3110001', industryCode: 'CS100001' });
    if (summary.kind !== 'OK') throw new Error(summary.kind);
    expect(summary.payload.quarters.map((quarter) => quarter.salesAmount)).toEqual(['123456789', '200']);

    const again = await loadMarketReleaseFromApi({ ...readOptions(), prisma: db(), log: () => {} });
    expect(again.outcome).toBe('ALREADY_ACTIVE');
    expect(again.releaseKey).toBe(report.releaseKey);
    expect(await db().marketRelease.count({ where: { releaseKey: report.releaseKey } })).toBe(1);
  }, 120000);
});
