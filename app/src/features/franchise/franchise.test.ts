import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { FranchiseError, type FetchLike } from './ftc-api.ts';
import { defaultLatestYear, loadFranchises, parseFtcRows, readFranchiseSources } from './loader.ts';
import { getFranchises } from './read.ts';
import { franchiseQuerySchema } from './schema.ts';
import { FTC_SERVICES } from './types.ts';

const KEY = 'FTCTESTKEY%2Bxyz';
type Row = Record<string, unknown>;

function storeRow(year: number, overrides: Row): Row {
  return {
    yr: String(year),
    indutyLclasNm: '외식',
    indutyMlsfcNm: '커피',
    corpNm: '(주)테스트',
    brandNm: '테스트커피',
    frcsCnt: 0,
    newFrcsRgsCnt: 0,
    ctrtEndCnt: 0,
    ctrtCncltnCnt: 0,
    nmChgCnt: 0,
    avrgSlsAmt: 0,
    arUnitAvrgSlsAmt: 0,
    ...overrides,
  };
}

function costRow(year: number, overrides: Row): Row {
  return {
    yr: String(year),
    indutyLclasNm: '외식',
    indutyMlsfcNm: '커피',
    corpNm: '(주)테스트',
    brandNm: '테스트커피',
    jngBzmnJngAmt: 0,
    jngBzmnEduAmt: 0,
    jngBzmnAssrncAmt: 0,
    jngBzmnEtcAmt: 0,
    smtnAmt: 0,
    ...overrides,
  };
}

type ApiData = { stores: Record<number, Row[]>; costs: Record<number, Row[]> };

function defaultData(): ApiData {
  const stores: Record<number, Row[]> = {};
  const costs: Record<number, Row[]> = {};
  for (const year of [2023, 2024, 2025]) {
    const grow = year - 2023;
    stores[year] = [
      storeRow(year, {
        corpNm: '(주)빽',
        brandNm: '빽커피',
        frcsCnt: 1400 + grow * 100,
        avrgSlsAmt: 300000 + grow,
        arUnitAvrgSlsAmt: 21000,
      }),
      // 실제 원본처럼 첫해는 가맹점 현황이 모두 0인 행이다(신규인지 미기재인지 알 수 없음).
      storeRow(
        year,
        year === 2023
          ? { corpNm: '메가(주)', brandNm: 'MEGA 커피' }
          : { corpNm: '메가(주)', brandNm: 'MEGA 커피', frcsCnt: 2500 + grow * 300, avrgSlsAmt: 350000 },
      ),
      storeRow(year, {
        corpNm: '새싹',
        brandNm: '새싹음료',
        indutyMlsfcNm: '음료 (커피 외)',
        frcsCnt: 4,
        avrgSlsAmt: 0,
      }),
      storeRow(year, { corpNm: '한상', brandNm: '한상차림', indutyMlsfcNm: '한식', frcsCnt: 50, avrgSlsAmt: 450000 }),
      storeRow(year, { corpNm: '한상', brandNm: '한상차림', indutyMlsfcNm: '주점', frcsCnt: 10, avrgSlsAmt: 400000 }),
      storeRow(year, { corpNm: '빵집', brandNm: '빵집', indutyMlsfcNm: '제과제빵', frcsCnt: 100, avrgSlsAmt: 500000 }),
      storeRow(year, {
        indutyLclasNm: '도소매',
        indutyMlsfcNm: '커피',
        corpNm: '원두',
        brandNm: '원두상점',
        frcsCnt: 3,
      }),
    ];
    costs[year] = [
      costRow(year, {
        corpNm: '(주)빽',
        brandNm: '빽커피',
        jngBzmnJngAmt: 5000,
        jngBzmnEduAmt: 0,
        jngBzmnAssrncAmt: 2000,
        jngBzmnEtcAmt: 1000,
        smtnAmt: 8000,
      }),
      costRow(year, { corpNm: '새싹', brandNm: '새싹음료', indutyMlsfcNm: '음료 (커피 외)' }),
      costRow(year, { corpNm: '없는', brandNm: '짝없는브랜드', jngBzmnJngAmt: 1, smtnAmt: 1 }),
    ];
  }
  return { stores, costs };
}

function reply(status: number, body: unknown) {
  return Promise.resolve({ status, text: () => Promise.resolve(JSON.stringify(body)) });
}

function fakeApi(data: ApiData) {
  const calls: string[] = [];
  const fetchImpl: FetchLike = (raw) => {
    calls.push(raw);
    const url = new URL(raw);
    const year = Number(url.searchParams.get('yr'));
    const page = Number(url.searchParams.get('pageNo'));
    const size = Number(url.searchParams.get('numOfRows'));
    const rows = url.pathname.endsWith(FTC_SERVICES.stores.path)
      ? (data.stores[year] ?? [])
      : url.pathname.endsWith(FTC_SERVICES.startupCosts.path)
        ? (data.costs[year] ?? [])
        : null;
    if (!rows) return reply(404, {});
    return reply(200, {
      resultCode: '00',
      resultMsg: 'NORMAL SERVICE',
      numOfRows: String(size),
      pageNo: String(page),
      totalCount: rows.length,
      items: rows.slice((page - 1) * size, page * size),
    });
  };
  return { fetchImpl, calls };
}

const readOptions = (data: ApiData = defaultData()) => ({
  serviceKey: KEY,
  fetchImpl: fakeApi(data).fetchImpl,
  pageSize: 3,
  retryDelayMs: 0,
  now: new Date('2026-09-24T00:00:00.000Z'),
});

async function expectFranchiseError(run: () => unknown): Promise<FranchiseError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof FranchiseError) return error;
    throw error;
  }
  throw new Error('FranchiseError가 발생하지 않았습니다.');
}

describe('공정위 가맹정보 해석', () => {
  it('진행 중인 연도를 빼고 한국 시간 기준 전년도를 최신 기준년도로 쓴다', () => {
    expect(defaultLatestYear(new Date('2026-09-24T00:00:00.000Z'))).toBe(2025);
    expect(defaultLatestYear(new Date('2026-12-31T16:00:00.000Z'))).toBe(2026);
  });

  it('외식 한식·커피·음료만 남기고, 같은 브랜드도 업종이 다르면 따로 둔다', () => {
    const rows = parseFtcRows(FTC_SERVICES.stores, 2025, defaultData().stores[2025]);
    expect(rows.map((row) => `${row.brandName}:${row.industryMiddle}`)).toEqual([
      '빽커피:커피',
      'MEGA 커피:커피',
      '새싹음료:음료 (커피 외)',
      '한상차림:한식',
    ]);
    const numeric = parseFtcRows(FTC_SERVICES.stores, 2025, [storeRow(2025, { frcsCnt: '12' })]);
    expect(numeric[0].amounts.frcsCnt).toBe(12);
  });

  it('필드 구성·연도·숫자·이름·중복이 어긋나면 멈춘다', async () => {
    const parse =
      (row: Row, extra: Row[] = []) =>
      () =>
        parseFtcRows(FTC_SERVICES.stores, 2025, [row, ...extra]);
    expect((await expectFranchiseError(parse(storeRow(2025, { newField: 1 })))).code).toBe('FIELD_MISMATCH');
    const missing = storeRow(2025, {});
    delete missing.avrgSlsAmt;
    expect((await expectFranchiseError(parse(missing))).code).toBe('FIELD_MISMATCH');
    expect((await expectFranchiseError(parse(storeRow(2024, {})))).code).toBe('INVALID_ROW');
    expect((await expectFranchiseError(parse(storeRow(2025, { frcsCnt: -1 })))).code).toBe('INVALID_ROW');
    expect((await expectFranchiseError(parse(storeRow(2025, { avrgSlsAmt: 1.5 })))).code).toBe('INVALID_ROW');
    expect((await expectFranchiseError(parse(storeRow(2025, { brandNm: ' ' })))).code).toBe('INVALID_ROW');
    expect((await expectFranchiseError(parse(storeRow(2025, {}), [storeRow(2025, {})]))).code).toBe('DUPLICATE_KEY');
  });

  it('조회 조건은 제품 업종, 40자 이하 검색어, 1~50개만 받는다', () => {
    expect(franchiseQuerySchema.safeParse({ industryCode: 'CS100010', query: ' 메가 ', limit: '10' }).data).toEqual({
      industryCode: 'CS100010',
      query: '메가',
      limit: 10,
    });
    expect(franchiseQuerySchema.safeParse({ industryCode: 'CS100002', query: '', limit: 10 }).success).toBe(false);
    expect(franchiseQuerySchema.safeParse({ industryCode: 'CS100010', query: 'x'.repeat(41), limit: 10 }).success).toBe(
      false,
    );
    expect(franchiseQuerySchema.safeParse({ industryCode: 'CS100010', query: '', limit: 51 }).success).toBe(false);
  });
});

describe('공정위 가맹정보 적재 원본', () => {
  it('3개 연도를 받아 평균매출 0은 미기재로, 창업 금액은 같은 키로 잇는다', async () => {
    const api = fakeApi(defaultData());
    const parsed = await readFranchiseSources({ ...readOptions(), fetchImpl: api.fetchImpl });
    expect(parsed.years).toEqual([2023, 2024, 2025]);
    expect(parsed.releaseKey).toMatch(/^ftc-franchise-2023-2025-[0-9a-f]{12}$/);
    expect(parsed.records).toHaveLength(12);
    const paik = parsed.records.find((record) => record.disclosureYear === 2025 && record.brandName === '빽커피');
    expect(paik).toMatchObject({
      marketIndustryCode: 'CS100010',
      storeCount: 1600,
      averageSalesThousand: '300002',
      franchiseFeeThousand: '5000',
      educationFeeThousand: '0',
      startupTotalThousand: '8000',
    });
    const sprout = parsed.records.find((record) => record.disclosureYear === 2025 && record.brandName === '새싹음료');
    expect(sprout).toMatchObject({
      averageSalesThousand: null,
      averageSalesPerAreaThousand: null,
      startupTotalThousand: null,
    });
    expect(parsed.records.find((record) => record.brandName === '한상차림')?.marketIndustryCode).toBe('CS100001');
    expect(parsed.checks.find((check) => check.name === '창업 금액 연결')?.detail).toBe(
      '6건을 연결했고 짝이 없는 창업 금액 행은 3건입니다.',
    );
    expect(parsed.sourceTables.map((table) => `${table.service}:${table.year}`)).toEqual([
      'stores:2023',
      'startupCosts:2023',
      'stores:2024',
      'startupCosts:2024',
      'stores:2025',
      'startupCosts:2025',
    ]);

    const reversed = defaultData();
    for (const year of [2023, 2024, 2025]) reversed.stores[year].reverse();
    expect((await readFranchiseSources(readOptions(reversed))).releaseKey).toBe(parsed.releaseKey);
  });

  it('창업 금액을 빼고 적재하면 키와 기록에 드러난다', async () => {
    const parsed = await readFranchiseSources({ ...readOptions(), includeStartupCosts: false });
    expect(parsed.releaseKey).toMatch(/^ftc-franchise-2023-2025-nocost-[0-9a-f]{12}$/);
    expect(parsed.startupCostsIncluded).toBe(false);
    expect(parsed.records.every((record) => record.startupTotalThousand === null)).toBe(true);
  });

  it('활용신청하지 않은 API는 재시도하지 않고 키를 가린 채 멈춘다', async () => {
    let calls = 0;
    const denied: FetchLike = () => {
      calls += 1;
      return reply(403, {
        OpenAPI_ServiceResponse: {
          cmmMsgHeader: { errMsg: 'SERVICE_KEY_IS_NOT_REGISTERED_ERROR', returnReasonCode: '30' },
        },
      });
    };
    const error = await expectFranchiseError(() => readFranchiseSources({ ...readOptions(), fetchImpl: denied }));
    expect(error.code).toBe('SERVICE_NOT_REGISTERED');
    expect(error.message).not.toContain(KEY);
    expect(calls).toBe(1);
  });

  it('기준년도 자료가 비었거나 받는 도중 건수가 바뀌면 멈춘다', async () => {
    const empty = defaultData();
    empty.stores[2025] = [];
    expect((await expectFranchiseError(() => readFranchiseSources(readOptions(empty)))).code).toBe('EMPTY_SOURCE');

    const data = defaultData();
    const api = fakeApi(data);
    let calls = 0;
    const shifting: FetchLike = (raw) => {
      if (++calls === 2) data.stores[2023].push(storeRow(2023, { brandNm: '늦게 온 브랜드' }));
      return api.fetchImpl(raw);
    };
    expect(
      (await expectFranchiseError(() => readFranchiseSources({ ...readOptions(data), fetchImpl: shifting }))).code,
    ).toBe('INCOMPLETE_SOURCE');
  });
});

// 가짜 API로 합성 릴리스를 전용 테스트 DB에 적재하고, 끝나면 지우고 이전 ACTIVE를 되돌린다.
describe.skipIf(!process.env.TEST_DATABASE_URL)('공정위 가맹정보 릴리스 적재(PostgreSQL)', () => {
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
    previousActiveId = (await db().franchiseRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;
  });

  afterAll(async () => {
    await db().franchiseRelease.deleteMany({ where: { createdAt: { gte: startedAt } } });
    if (previousActiveId) {
      const previous = await db().franchiseRelease.findUnique({ where: { id: previousActiveId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().franchiseRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
        await db().franchiseRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
  });

  it('릴리스를 활성화해 업종별 브랜드를 원 단위로 돌려주고, 같은 내용은 다시 적재하지 않는다', async () => {
    const report = await loadFranchises({ ...readOptions(), prisma: db() });
    expect(report.outcome).toBe('ACTIVATED');
    expect(report.brandCount).toBe(12);

    const top = await getFranchises(db(), { industryCode: 'CS100010', query: '', limit: 10 });
    if (top.kind !== 'OK') throw new Error(top.kind);
    expect(top.payload.source).toMatchObject({
      latestDisclosureYear: 2025,
      latestPerformanceYear: 2024,
      startupCostsIncluded: true,
    });
    expect(top.payload.summary).toEqual({ brandCount: 3, brandsWithStores: 3, brandsWithSales: 2 });
    expect(top.payload.brands.map((brand) => brand.brandName)).toEqual(['MEGA 커피', '빽커피', '새싹음료']);
    const paik = top.payload.brands[1];
    expect(paik.latest).toMatchObject({
      storeCount: 1600,
      averageSalesWon: '300002000',
      averageMonthlySalesWon: '25000167',
      averageSalesPerAreaWon: '21000000',
    });
    expect(paik.latest.startupCosts).toEqual({
      franchiseFeeWon: '5000000',
      educationFeeWon: '0',
      depositWon: '2000000',
      otherCostWon: '1000000',
      totalWon: '8000000',
    });
    expect(paik.history.map((item) => [item.performanceYear, item.storeCount, item.statusReported])).toEqual([
      [2022, 1400, true],
      [2023, 1500, true],
      [2024, 1600, true],
    ]);
    // 모든 수치가 0인 해는 0개로 확정하지 않고 현황 없음으로 표시할 수 있게 구분한다.
    expect(top.payload.brands[0].history.map((item) => [item.performanceYear, item.statusReported])).toEqual([
      [2022, false],
      [2023, true],
      [2024, true],
    ]);

    const search = await getFranchises(db(), { industryCode: 'CS100010', query: 'mega', limit: 10 });
    if (search.kind !== 'OK') throw new Error(search.kind);
    expect(search.payload.brands.map((brand) => brand.brandName)).toEqual(['MEGA 커피']);
    const byCorp = await getFranchises(db(), { industryCode: 'CS100001', query: '한상', limit: 10 });
    if (byCorp.kind !== 'OK') throw new Error(byCorp.kind);
    expect(byCorp.payload.brands.map((brand) => brand.industryMiddle)).toEqual(['한식']);

    const again = await loadFranchises({ ...readOptions(), prisma: db() });
    expect(again.outcome).toBe('ALREADY_ACTIVE');
    expect(await db().franchiseRelease.count({ where: { releaseKey: report.releaseKey } })).toBe(1);
  }, 120000);
});
