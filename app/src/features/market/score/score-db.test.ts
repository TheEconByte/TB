import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@/generated/prisma/client';
import { resolvePlanMarketScore } from '@/features/plans/market-score';
import { getMarketScore } from './api.ts';
import { DEFAULT_GRADE_BOUNDARIES } from './config.ts';
import { buildScoreRelease } from './loader.ts';
import type { MarketScoreModel } from './model.ts';

// 합성 상권 릴리스로 score:build → 점수 API → 계획 스냅샷을 실제 PostgreSQL에서 확인한다.
// 끝나면 만든 릴리스를 지우고 실행 전 ACTIVE 상태를 되돌린다.
describe.skipIf(!process.env.TEST_DATABASE_URL)('상권 생존점수 적재와 조회', () => {
  let client: PrismaClient | null = null;
  let startedAt = new Date(0);
  let previousMarketId: string | null = null;
  let previousScoreId: string | null = null;
  const suffix = `${Date.now()}`;
  const marketReleaseId = `test-market-${suffix}`;
  const db = () => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  const model: MarketScoreModel = {
    version: `market-score-test-${suffix}`,
    definitionVersion: 'market-score-def-test',
    createdAt: '2026-10-31T00:00:00.000Z',
    marketReleaseKey: marketReleaseId,
    dataPeriod: { start: '20252', end: '20262' },
    minStoreCount: 5,
    gradeBoundaries: [...DEFAULT_GRADE_BOUNDARIES],
    industries: ['CS100001', 'CS100010'].map((industryCode) => ({
      industryCode,
      industryName: industryCode === 'CS100001' ? '한식' : '커피·음료',
      intercept: 0,
      features: [
        {
          key: 'salesPerStore' as const,
          label: '점포당 매출',
          definition: '테스트 정의',
          expectedScoreDirection: 1 as const,
          beta: -1,
          standardError: 0.1,
          pValue: 0,
          mean: Math.log(400),
          std: 1,
        },
        {
          key: 'pastClosureRate' as const,
          label: '직전 1년 폐업률',
          definition: '테스트 정의',
          expectedScoreDirection: -1 as const,
          beta: 0.5,
          standardError: 0.1,
          pValue: 0,
          mean: 0.4,
          std: 0.2,
        },
      ],
      trainQuarters: ['20221'],
      testQuarters: ['20243'],
      trainSize: 100,
      testSize: 40,
      trainPositiveRate: 0.5,
      testPositiveRate: 0.5,
      trainAuc: 0.7,
      testAuc: industryCode === 'CS100001' ? 0.65 : 0.55,
      zClip: 3,
    })),
  };

  function modelFile(value: MarketScoreModel): string {
    const dir = mkdtempSync(join(tmpdir(), 'market-score-'));
    const path = join(dir, `${value.version}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  }

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    startedAt = new Date();
    previousMarketId = (await db().marketRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;
    previousScoreId = (await db().marketScoreRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;

    // 활성화 시각을 미래로 두어 기존 ACTIVE보다 먼저 조회되게 한다.
    await db().marketRelease.create({
      data: {
        id: marketReleaseId,
        releaseKey: marketReleaseId,
        label: '합성 상권 릴리스',
        status: 'ACTIVE',
        schemaVersion: 'test',
        definitionVersion: 'test',
        sourceUrl: 'https://data.seoul.go.kr/',
        basisPeriod: '20252-20262',
        basisPeriodLabel: '2025년 2분기~2026년 2분기',
        retrievedAt: new Date(),
        files: [],
        validationSummary: {},
        activatedAt: new Date(Date.now() + 86_400_000),
      },
    });
    for (const code of ['CS100001', 'CS100010']) {
      await db().industry.create({
        data: {
          releaseId: marketReleaseId,
          code,
          sourceName: code,
          displayName: code,
          displayNameSource: 'TEST',
          sourceCategoryVersion: 'test',
          isSupported: true,
        },
      });
    }
    const areas = [
      ['3119901', '정상 상권'],
      ['3119902', '점포 적은 상권'],
      ['3119903', '자료 없는 상권'],
    ];
    for (const [areaCode, name] of areas) {
      await db().marketArea.create({
        data: {
          releaseId: marketReleaseId,
          areaType: 'A',
          areaCode,
          sourceName: name,
          areaTypeName: '골목상권',
          districtCode: '11200',
          districtName: '성동구',
        },
      });
    }
    const quarters = ['20252', '20253', '20254', '20261', '20262'];
    for (const quarter of quarters) {
      for (const [areaCode, stores] of [
        ['3119901', 10],
        ['3119902', 3],
      ] as const) {
        await db().marketQuarterly.create({
          data: {
            releaseId: marketReleaseId,
            quarter,
            areaType: 'A',
            areaCode,
            industryCode: 'CS100001',
            salesAmount: '4000',
            similarIndustryStoreCount: stores,
            storeCount: stores,
            franchiseStoreCount: 0,
            openedStoreCount: 1,
            closedStoreCount: 1,
          },
        });
      }
    }
  });

  afterAll(async () => {
    await db().marketScoreRelease.deleteMany({ where: { createdAt: { gte: startedAt } } });
    await db().marketRelease.deleteMany({ where: { id: marketReleaseId } });
    if (previousScoreId) {
      await db().marketScoreRelease.update({ where: { id: previousScoreId }, data: { status: 'ACTIVE' } });
    }
    if (previousMarketId) {
      const previous = await db().marketRelease.findUnique({ where: { id: previousMarketId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().marketRelease.update({ where: { id: previousMarketId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
  });

  it('검증을 통과한 점수 릴리스만 활성화하고 같은 내용은 다시 쓰지 않는다', async () => {
    const path = modelFile(model);
    const report = await buildScoreRelease({ prisma: db(), modelPath: path });
    expect(report.outcome).toBe('ACTIVATED');
    expect(report.baseQuarter).toBe('20262');
    expect(report.rowCount).toBe(3);
    expect(report.summary.servedIndustryCodes).toEqual(['CS100001']);
    expect(report.warnings.some((warning) => warning.includes('커피·음료'))).toBe(true);

    const rows = await db().marketScore.findMany({
      where: { releaseId: report.releaseId },
      orderBy: { areaCode: 'asc' },
    });
    expect(rows.map((row) => row.status)).toEqual(['SCORED', 'INSUFFICIENT_STORES', 'NO_DATA']);
    expect(rows[0].monthlyRevenueDefault?.toFixed(0)).toBe('400');

    const again = await buildScoreRelease({ prisma: db(), modelPath: path });
    expect(again.outcome).toBe('ALREADY_ACTIVE');
    expect(await db().marketScoreRelease.count({ where: { releaseKey: report.releaseKey } })).toBe(1);
  }, 60000);

  it('검증에 실패하면 기존 활성 점수 릴리스를 그대로 둔다', async () => {
    const active = await db().marketScoreRelease.findFirst({ where: { status: 'ACTIVE' } });
    const broken = { ...model, version: `market-score-broken-${suffix}`, minStoreCount: 1000 };
    await expect(buildScoreRelease({ prisma: db(), modelPath: modelFile(broken) })).rejects.toThrow(
      '점수를 낸 상권이 없습니다',
    );
    const after = await db().marketScoreRelease.findFirst({ where: { status: 'ACTIVE' } });
    expect(after?.id).toBe(active?.id);
  });

  it('점수 API는 정상·표본 부족·미지원 업종·데이터 없음을 200으로 구분한다', async () => {
    const ok = await getMarketScore(db(), { areaCode: '3119901', industryCode: 'CS100001' });
    expect(ok.kind).toBe('OK');
    if (ok.kind !== 'OK') return;
    expect(ok.payload).toMatchObject({
      status: 'OK',
      message: null,
      storeCount: 10,
      area: { displayName: '정상 상권', districtCode: '11200' },
      score: { rank: 1, total: 1, topPercent: 100 },
      financeDefault: { monthlyRevenue: '400', provisional: true, unusual: null },
    });
    expect(ok.payload.contributions.length).toBeLessThanOrEqual(4);
    expect(ok.payload.distribution?.total).toBe(1);
    expect(ok.payload.model?.coefficients).toHaveLength(2);

    const few = await getMarketScore(db(), { areaCode: '3119902', industryCode: 'CS100001' });
    expect(few.kind === 'OK' && few.payload).toMatchObject({
      status: 'INSUFFICIENT_STORES',
      message: '점포가 3개뿐이라 점수를 내지 않습니다.',
      score: null,
      financeDefault: null,
    });
    const none = await getMarketScore(db(), { areaCode: '3119903', industryCode: 'CS100001' });
    expect(none.kind === 'OK' && none.payload).toMatchObject({
      status: 'NO_DATA',
      message: '이 상권은 최근 데이터가 없습니다.',
    });
    const coffee = await getMarketScore(db(), { areaCode: '3119901', industryCode: 'CS100010' });
    expect(coffee.kind === 'OK' && coffee.payload).toMatchObject({
      status: 'UNSUPPORTED_INDUSTRY',
      message: '현재 한식만 지원합니다.',
    });

    expect((await getMarketScore(db(), { areaCode: '9999999', industryCode: 'CS100001' })).kind).toBe('AREA_NOT_FOUND');
    expect((await getMarketScore(db(), { areaCode: 'x', industryCode: 'CS100001' })).kind).toBe('INVALID_AREA_CODE');
  });

  it('계획 스냅샷은 점수 릴리스에서 다시 읽고, 점수를 내지 않은 상권은 받지 않는다', async () => {
    const active = await db().marketScoreRelease.findFirstOrThrow({ where: { status: 'ACTIVE' } });
    const reference = { releaseKey: active.releaseKey, areaType: 'A', areaCode: '3119901', industryCode: 'CS100001' };
    const snapshot = await resolvePlanMarketScore(db(), reference, new Date('2026-10-31T00:00:00Z'));
    expect(snapshot).toMatchObject({
      releaseKey: active.releaseKey,
      modelVersion: model.version,
      areaName: '정상 상권',
      districtName: '성동구',
      monthlyRevenueDefault: '400',
      savedAt: '2026-10-31T00:00:00.000Z',
    });
    expect(await resolvePlanMarketScore(db(), { ...reference, areaCode: '3119902' })).toBeNull();
    expect(await resolvePlanMarketScore(db(), { ...reference, releaseKey: 'missing-release' })).toBeNull();
  });
});
