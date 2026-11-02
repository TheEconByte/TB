import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { evaluateCandidates } from './eligibility.ts';
import { findActiveFundingCatalog } from './read.ts';
import { createBizinfoAdapter } from './sources/bizinfo.ts';
import {
  nextPatchVersion,
  productContentFingerprint,
  runFundingSync,
  type CollectedFundingProduct,
  type FundingSourceAdapter,
  type FundingSourceCollection,
} from './sync.ts';
import { AUTO_REVIEWER, FUNDING_CATALOG_SCHEMA_VERSION } from './types.ts';
import { FundingCatalogError } from './validation.ts';

const CREATED_DIRS: string[] = [];
// 기업마당 테스트 공고의 상품 키 앞부분. 테스트 DB에서 지울 때 쓴다.
const BIZINFO_TEST_KEY_PREFIX = 'bizinfo-pbln-test';
const OLS_URL = 'https://ols.semas.or.kr/ols/man/SMAN018M/page.do';

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'trendbench-sync-'));
  CREATED_DIRS.push(dir);
  return dir;
}

function evidence(id: string, subject: string, observedAt: string): Record<string, unknown> {
  return {
    id,
    subject,
    summary: '공식 페이지에서 해당 조건을 확인했습니다.',
    sourceUrl: OLS_URL,
    sourceDocumentName: '정책자금 한눈에 보기',
    observedAt,
    retrievalMethod: 'OFFICIAL_WEB_PAGE',
    checksum: null,
  };
}

// 수집기가 만드는 모양 그대로의 정책자금 상품. 버전과 검수자는 동기화가 정한다.
function collected(externalId: string, observedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    productKey: `test-sync-${externalId}`,
    name: `테스트 정책자금 ${externalId}`,
    organization: '소상공인시장진흥공단',
    supportType: 'LOAN',
    eligibleBusinessStages: ['POST_REGISTRATION'],
    region: { scope: 'NATIONWIDE', districtCodes: [], note: null },
    purpose: { included: ['OPERATING_FUNDS'], excluded: [], note: null },
    industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: '업종 조건은 공고 본문에서 확인합니다.' },
    applicationPeriod: { start: null, end: null, note: '예산 소진 시까지 접수합니다.' },
    observedApplicationStatus: 'OPEN',
    observedAt,
    reviewedAt: observedAt,
    nextReviewAt: null,
    officialUrl: OLS_URL,
    sourceDocumentName: '정책자금 한눈에 보기',
    sourceDocumentRetrieved: false,
    sourceChecksum: null,
    publicLimit: '70000000',
    interestCondition: '정책자금 기준금리 + 0.6%p',
    interestRateConfirmed: false,
    interestRatePercent: null,
    repaymentCondition: '5년(거치 2년 포함)',
    repaymentMethod: 'UNKNOWN',
    repaymentTermMonths: null,
    repaymentGraceMonths: null,
    unsupportedCalculationReasons: ['금리가 기준금리 연동이라 확정 숫자가 아닙니다.'],
    additionalChecks: [],
    evidence: [
      evidence('identity', 'IDENTITY', observedAt),
      evidence('period', 'APPLICATION_PERIOD', observedAt),
      evidence('stage', 'BUSINESS_STAGE', observedAt),
      evidence('region', 'REGION', observedAt),
      evidence('purpose', 'PURPOSE', observedAt),
      evidence('financial', 'FINANCIAL_CONDITION', observedAt),
    ],
    sourceRef: { source: 'SEMAS_OLS', externalId },
    ...overrides,
  } as unknown as CollectedFundingProduct;
}

function adapter(result: () => FundingSourceCollection): FundingSourceAdapter {
  return { source: 'SEMAS_OLS', collect: async () => result() };
}

function collection(products: CollectedFundingProduct[], fetchedCount = 10): FundingSourceCollection {
  return { products, fetchedCount, responseChecksum: 'a'.repeat(64) };
}

// 사람이 관리하는 카탈로그. 자동 상품과 겹치지 않는 상품 하나를 둔다.
function manualCatalogFile(products: Record<string, unknown>[] = [manualProduct()]): string {
  const path = join(tempDir(), 'catalog.json');
  writeFileSync(
    path,
    JSON.stringify({
      catalogKey: 'test-sync-catalog',
      schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
      catalogVersion: '2026-09-20.1',
      basisDate: '2026-09-20',
      reviewer: 'tester',
      notes: [],
      automation: { policyLoanPromotion: true, repaymentPromotion: false, blockedSources: [], sourceSyncs: [] },
      products,
    }),
    'utf8',
  );
  return path;
}

function manualProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const product = collected('manual', '2026-09-20') as unknown as Record<string, unknown>;
  delete product.sourceRef;
  return {
    ...product,
    productKey: 'test-sync-manual',
    version: '1.0.0',
    name: '사람이 검수한 테스트 상품',
    reviewer: 'tester',
    nextReviewAt: '2099-01-01',
    ...overrides,
  };
}

afterAll(() => {
  for (const dir of CREATED_DIRS) rmSync(dir, { recursive: true, force: true });
});

describe('상품 버전 재사용 규칙', () => {
  it('날짜와 근거 checksum만 다른 상품은 같은 내용으로 본다', () => {
    const first = collected('fund-a', '2026-09-20');
    const later = collected('fund-a', '2026-09-21', {
      evidence: [
        { ...evidence('identity', 'IDENTITY', '2026-09-21'), checksum: 'b'.repeat(64) },
        evidence('period', 'APPLICATION_PERIOD', '2026-09-21'),
        evidence('stage', 'BUSINESS_STAGE', '2026-09-21'),
        evidence('region', 'REGION', '2026-09-21'),
        evidence('purpose', 'PURPOSE', '2026-09-21'),
        evidence('financial', 'FINANCIAL_CONDITION', '2026-09-21'),
      ],
    });
    expect(productContentFingerprint({ ...first, reviewer: AUTO_REVIEWER })).toBe(
      productContentFingerprint({ ...later, reviewer: AUTO_REVIEWER }),
    );
    const changed = collected('fund-a', '2026-09-20', { publicLimit: '50000000' });
    expect(productContentFingerprint({ ...changed, reviewer: AUTO_REVIEWER })).not.toBe(
      productContentFingerprint({ ...first, reviewer: AUTO_REVIEWER }),
    );
  });

  it('가장 높은 버전의 PATCH를 올린다', () => {
    expect(nextPatchVersion([])).toBe('1.0.0');
    expect(nextPatchVersion(['1.0.0', '1.0.2', '1.0.1'])).toBe('1.0.3');
    expect(nextPatchVersion(['1.0.9', '1.1.0'])).toBe('1.1.1');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('funding:sync와 PostgreSQL', () => {
  let client: PrismaClient | null = null;
  let startedAt = new Date(0);
  let previousActiveId: string | null = null;

  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  const sync = (options: {
    asOfDate: string;
    result: () => FundingSourceCollection;
    catalogPath?: string;
    dryRun?: boolean;
  }) =>
    runFundingSync({
      prisma: db(),
      catalogPath: options.catalogPath ?? manualCatalogFile(),
      adapters: [adapter(options.result)],
      asOfDate: options.asOfDate,
      outputDir: tempDir(),
      dryRun: options.dryRun,
      now: () => new Date(`${options.asOfDate}T01:00:00.000Z`),
    });

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    const stale = await db().fundingCatalogRelease.findMany({
      where: { catalogKey: { startsWith: 'test-' } },
      select: { id: true },
    });
    if (stale.length > 0) {
      const staleIds = stale.map((release) => release.id);
      await db().fundingCatalogProduct.deleteMany({ where: { catalogReleaseId: { in: staleIds } } });
      await db().fundingCatalogRelease.deleteMany({ where: { id: { in: staleIds } } });
    }
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-' } } });
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: BIZINFO_TEST_KEY_PREFIX } } });
    const baseline = await db().fundingCatalogRelease.findFirst({
      where: { catalogKey: { not: { startsWith: 'test-' } }, status: { in: ['ACTIVE', 'SUPERSEDED'] } },
      orderBy: { activatedAt: 'desc' },
    });
    if (baseline) {
      await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
      await db().fundingCatalogRelease.update({ where: { id: baseline.id }, data: { status: 'ACTIVE' } });
    }
    startedAt = new Date();
    previousActiveId = (await db().fundingCatalogRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;
  });

  afterAll(async () => {
    const releases = await db().fundingCatalogRelease.findMany({ where: { createdAt: { gte: startedAt } } });
    for (const release of releases) await db().fundingCatalogRelease.delete({ where: { id: release.id } });
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-' } } });
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: BIZINFO_TEST_KEY_PREFIX } } });
    if (previousActiveId) {
      const previous = await db().fundingCatalogRelease.findUnique({ where: { id: previousActiveId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
        await db().fundingCatalogRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
  });

  it('출처 상품을 사람이 관리하는 상품과 합쳐 ACTIVE로 적재한다', async () => {
    const report = await sync({
      asOfDate: '2026-09-20',
      result: () => collection([collected('fund-a', '2026-09-20'), collected('fund-b', '2026-09-20')]),
    });
    expect(report.load?.outcome).toBe('ACTIVATED');
    // 사람이 관리하는 카탈로그의 버전(2026-09-20.1)과 겹치지 않게 번호를 올린다.
    expect(report.catalogVersion).toBe('2026-09-20.2');
    expect(report.sources).toMatchObject([
      { source: 'SEMAS_OLS', status: 'SUCCEEDED', lastSucceededOn: '2026-09-20', fetchedCount: 10, productCount: 2 },
    ]);
    expect(report.sources[0].addedProducts.map((product) => product.productKey)).toEqual([
      'test-sync-fund-a',
      'test-sync-fund-b',
    ]);

    const active = await findActiveFundingCatalog(db());
    expect(active?.catalogKey).toBe('test-sync-catalog');
    expect(active?.schemaVersion).toBe(FUNDING_CATALOG_SCHEMA_VERSION);
    expect(active?.catalog.products.map((product) => `${product.productKey}@${product.version}`)).toEqual([
      'test-sync-manual@1.0.0',
      'test-sync-fund-a@1.0.0',
      'test-sync-fund-b@1.0.0',
    ]);
    expect(active?.catalog.products[1].reviewer).toBe(AUTO_REVIEWER);
    expect(active?.automation.policyLoanPromotion).toBe(true);
    expect(active?.automation.sourceSyncs).toMatchObject([
      { source: 'SEMAS_OLS', status: 'SUCCEEDED', lastSucceededOn: '2026-09-20', failureReason: null },
    ]);
  });

  it('내용이 같은 상품은 버전을 재사용하고, 바뀐 상품은 새 버전을 만든다', async () => {
    const report = await sync({
      asOfDate: '2026-09-21',
      result: () =>
        collection([collected('fund-a', '2026-09-21'), collected('fund-b', '2026-09-21', { publicLimit: '50000000' })]),
    });
    expect(report.catalogVersion).toBe('2026-09-21.1');
    // 직전 릴리스에 있던 공고는 새 공고로 알리지 않는다.
    expect(report.sources[0].addedProducts).toEqual([]);
    const active = await findActiveFundingCatalog(db());
    const byKey = new Map(active?.catalog.products.map((product) => [product.productKey, product]));
    expect(byKey.get('test-sync-fund-a')?.version).toBe('1.0.0');
    expect(byKey.get('test-sync-fund-a')?.observedAt).toBe('2026-09-20');
    expect(byKey.get('test-sync-fund-b')?.version).toBe('1.0.1');
    expect(byKey.get('test-sync-fund-b')?.publicLimit).toBe('50000000');
    expect(active?.automation.sourceSyncs[0].lastSucceededOn).toBe('2026-09-21');
  });

  it('출처가 실패하면 직전 상품과 마지막 성공일을 그대로 두고 실패 사유를 남긴다', async () => {
    const report = await sync({
      asOfDate: '2026-09-22',
      result: () => {
        throw new Error('출처 응답 403');
      },
    });
    expect(report.load?.outcome).toBe('ACTIVATED');
    expect(report.sources[0]).toMatchObject({
      status: 'FAILED',
      lastSucceededOn: '2026-09-21',
      fetchedCount: 10,
      carriedOver: true,
      productCount: 2,
      addedProducts: [],
    });
    expect(report.sources[0].failureReason).toContain('출처 응답 403');
    const active = await findActiveFundingCatalog(db());
    expect(active?.catalog.products.map((product) => `${product.productKey}@${product.version}`)).toEqual([
      'test-sync-manual@1.0.0',
      'test-sync-fund-a@1.0.0',
      'test-sync-fund-b@1.0.1',
    ]);
    expect(active?.automation.sourceSyncs[0]).toMatchObject({ status: 'FAILED', lastSucceededOn: '2026-09-21' });
  });

  it('빈 응답과 직전 성공 대비 절반 미만의 공고 수는 실패로 기록한다', async () => {
    const empty = await sync({ asOfDate: '2026-09-23', result: () => collection([], 0) });
    expect(empty.sources[0].status).toBe('FAILED');
    expect(empty.sources[0].failureReason).toContain('공고 없음');

    const dropped = await sync({
      asOfDate: '2026-09-23',
      result: () => collection([collected('fund-a', '2026-09-23')], 4),
    });
    expect(dropped.catalogVersion).toBe('2026-09-23.2');
    expect(dropped.sources[0].status).toBe('FAILED');
    expect(dropped.sources[0].failureReason).toContain('절반 미만');
    expect(dropped.sources[0].productCount).toBe(2);
  });

  it('검증을 통과하지 못한 상품이 있으면 그 출처만 실패로 기록한다', async () => {
    const report = await sync({
      asOfDate: '2026-09-24',
      result: () =>
        collection([
          collected('fund-a', '2026-09-24'),
          collected('fund-b', '2026-09-24', { applicationPeriod: { start: null, end: null, note: null } }),
        ]),
    });
    expect(report.load?.outcome).toBe('ACTIVATED');
    expect(report.sources[0].status).toBe('FAILED');
    expect(report.sources[0].failureReason).toContain('APPLICATION_PERIOD_NOTE_MISSING');
    expect(report.manualProductCount).toBe(1);
    expect(report.automatedProductCount).toBe(2);
  });

  it('사람이 기록한 상품이 같은 공고를 가리키면 자동 상품을 뺀다', async () => {
    const catalogPath = manualCatalogFile([
      manualProduct(),
      manualProduct({
        productKey: 'test-sync-manual-fund-a',
        sourceRef: { source: 'SEMAS_OLS', externalId: 'fund-a' },
      }),
    ]);
    const report = await sync({
      asOfDate: '2026-09-25',
      catalogPath,
      result: () => collection([collected('fund-a', '2026-09-25'), collected('fund-b', '2026-09-25')]),
    });
    expect(report.sources[0].status).toBe('SUCCEEDED');
    expect(report.overriddenByManual).toEqual(['SEMAS_OLS:fund-a']);
    const active = await findActiveFundingCatalog(db());
    expect(active?.catalog.products.map((product) => product.productKey)).toEqual([
      'test-sync-manual',
      'test-sync-manual-fund-a',
      'test-sync-fund-b',
    ]);
  });

  it('dry run은 합친 카탈로그를 쓰고 검증만 하며 적재하지 않는다', async () => {
    const before = await db().fundingCatalogRelease.count();
    const report = await sync({
      asOfDate: '2026-09-26',
      dryRun: true,
      result: () => collection([collected('fund-a', '2026-09-26'), collected('fund-b', '2026-09-26')]),
    });
    expect(report.load).toBeNull();
    expect(existsSync(report.catalogFile)).toBe(true);
    expect(await db().fundingCatalogRelease.count()).toBe(before);
  });

  it('기업마당 공고를 유형·사업 단계 미확인 상품으로 적재하고 추가 확인으로 둔다', async () => {
    const response = JSON.stringify({
      jsonArray: [
        {
          pblancId: 'PBLN_TEST_0001',
          pblancNm: '[서울] 소상공인 경영 개선 지원사업 공고',
          pblancUrl: '/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_TEST_0001',
          jrsdInsttNm: '서울특별시',
          excInsttNm: '서울신용보증재단',
          reqstBeginEndDe: '2026-09-01 ~ 2026-10-31',
          trgetNm: '소상공인',
          pldirSportRealmLclasCodeNm: '경영',
          totCnt: 2,
        },
        {
          pblancId: 'PBLN_TEST_0002',
          pblancNm: '[경기] 소상공인 지원사업 공고',
          pblancUrl: '/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_TEST_0002',
          jrsdInsttNm: '경기도',
          excInsttNm: '',
          reqstBeginEndDe: '2026-09-01 ~ 2026-10-31',
          trgetNm: '소상공인',
          pldirSportRealmLclasCodeNm: '경영',
          totCnt: 2,
        },
      ],
    });
    const report = await runFundingSync({
      prisma: db(),
      catalogPath: manualCatalogFile(),
      adapters: [
        createBizinfoAdapter({
          apiKey: 'test-key',
          fetchImpl: async () => ({ status: 200, text: async () => response }),
        }),
      ],
      asOfDate: '2026-09-28',
      outputDir: tempDir(),
      now: () => new Date('2026-09-28T01:00:00.000Z'),
    });
    expect(report.load?.outcome).toBe('ACTIVATED');
    expect(report.sources).toMatchObject([
      { source: 'BIZINFO', status: 'SUCCEEDED', lastSucceededOn: '2026-09-28', fetchedCount: 2, productCount: 1 },
    ]);
    expect(report.sources[0].addedProducts).toEqual([
      { productKey: 'bizinfo-pbln-test-0001', name: '[서울] 소상공인 경영 개선 지원사업 공고' },
    ]);

    const stored = await db().fundingProductVersion.findUnique({
      where: { productKey_version: { productKey: 'bizinfo-pbln-test-0001', version: '1.0.0' } },
    });
    expect(stored?.supportType).toBe('UNKNOWN');
    expect(stored?.repaymentCalculationSupported).toBe(false);

    const active = await findActiveFundingCatalog(db());
    if (!active) throw new Error('ACTIVE 카탈로그가 없습니다.');
    const list = evaluateCandidates(
      active.catalog,
      { businessStage: 'PRE_REGISTRATION', districtCode: '11140', industryCode: 'CS100010', purpose: 'STARTUP_COST' },
      { asOfDate: '2026-09-28' },
    );
    const bizinfo = list.evaluations.find((evaluation) => evaluation.productKey === 'bizinfo-pbln-test-0001');
    expect(bizinfo).toMatchObject({ supportType: 'UNKNOWN', candidateStatus: 'NEEDS_CONFIRMATION' });
  });

  it('사람이 관리하는 카탈로그에 자동 검수자 상품이 있으면 거부한다', async () => {
    const catalogPath = manualCatalogFile([
      manualProduct(),
      manualProduct({
        productKey: 'test-sync-manual-auto',
        reviewer: AUTO_REVIEWER,
        nextReviewAt: null,
        sourceRef: { source: 'SEMAS_OLS', externalId: 'fund-z' },
      }),
    ]);
    await expect(
      sync({ asOfDate: '2026-09-27', catalogPath, result: () => collection([collected('fund-a', '2026-09-27')]) }),
    ).rejects.toBeInstanceOf(FundingCatalogError);
  });
});
