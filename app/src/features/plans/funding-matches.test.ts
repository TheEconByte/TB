import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from '../../lib/checksum.ts';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getPrisma: vi.fn() }));
vi.mock('@/lib/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }));

import { POST as postMatches } from '@/app/api/plans/[planId]/funding-matches/route';
import { POST as createPlan } from '@/app/api/plans/route';
import { PUT as updatePlan } from '@/app/api/plans/[planId]/route';
import { todayInKst } from '@/features/funding/dates.ts';
import { loadFundingCatalog } from '@/features/funding/loader.ts';
import type { FundingMatchProfile } from '@/features/funding/matching.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from '@/features/funding/types.ts';
import type { FinanceInput } from '@/features/finance/types';
import type { PlanFundingMatchesResponse } from './funding-matches.ts';

// 계획에 저장한 자금 조건으로 맞춰 본다(ADR 0009 §4, 5c). 경계는 기존과 같다: 미로그인 401, 없거나 타인 소유 404,
// 저장된 조건이 없거나 모양이 틀리면 400, 활성 릴리스 없음 503. 자치구는 자금 조건 → 사업 프로필 순으로 서버가 정한다.

const FAR_FUTURE = '2099-01-01';
// 실제 카탈로그의 기준일(catalog.json basisDate). 적재 규칙 검사를 이 날짜로 한다.
const LOAD_DATE = '2026-11-03';
const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';
const NOTICE_CHECKSUM = sha256Hex('성동구 공고 본문');
const CREATED_DIRS: string[] = [];

const input: FinanceInput = {
  openingExpenses: { deposit: '10', facilities: '20', initialInventory: null, otherPreparation: '0' },
  targetReserve: '5',
  equity: '15',
  monthlyRevenue: null,
  monthlyFixedCosts: { rent: '1', labor: '0', other: '0' },
  variableCostRate: '0',
  existingMonthlyDebtPayment: '0',
  newLoan: {
    principal: '0',
    annualInterestRatePercent: null,
    totalMonths: null,
    graceMonths: null,
    repaymentMethod: null,
  },
  cashBalanceMonths: 12,
};

const PROFILE: FundingMatchProfile = {
  businessStatus: 'PRE_STARTUP',
  openedYearMonth: null,
  districtCode: '11200',
  age: 35,
  targetGroups: [],
};
// 5c 전에 저장된 모양(업종·용도가 있던 자금 조건).
const LEGACY_PROFILE = {
  businessStage: 'POST_REGISTRATION',
  districtCode: '11200',
  industryCode: 'CS100010',
  purpose: 'OPERATING_FUNDS',
};
const BUSINESS_PROFILE_JSON = { districtCode: '11440', districtName: '마포구', marketIndustryCode: 'CS100001' };

const evidence = (id: string, subject: string) => ({
  id,
  subject,
  summary: '공식 원문에서 해당 조건을 확인했습니다.',
  sourceUrl: OFFICIAL_URL,
  sourceDocumentName: '테스트 공고문',
  observedAt: '2026-11-01',
  retrievalMethod: 'OFFICIAL_WEB_PAGE',
  checksum: null,
});

// 자치구 한정을 AI가 읽은 자동 상품. 자동 상품은 운영자 값을 쓰지 않으므로 지역은 추출 결과로만 정해진다.
const PRODUCT = {
  productKey: 'bizinfo-pbln-seongdong',
  version: '1.0.0',
  name: '성동구 소상공인 지원사업',
  organization: '성동구',
  supportType: 'UNKNOWN',
  eligibleBusinessStages: [],
  region: { scope: 'UNKNOWN', districtCodes: [], note: '기업마당 공고에서 대상 지역을 확인하지 못했습니다.' },
  purpose: { included: [], excluded: [], note: null },
  industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: null },
  applicationPeriod: { start: '2026-01-01', end: FAR_FUTURE, note: null },
  observedApplicationStatus: 'OPEN',
  observedAt: '2026-11-01',
  officialUrl: OFFICIAL_URL,
  sourceDocumentName: '기업마당 지원사업 공고',
  sourceDocumentRetrieved: false,
  sourceChecksum: null,
  publicLimit: null,
  interestCondition: null,
  interestRateConfirmed: false,
  repaymentCondition: null,
  repaymentMethod: 'UNKNOWN',
  unsupportedCalculationReasons: ['상환 계산 대상이 아닙니다.'],
  additionalChecks: [],
  origin: 'SYNC',
  evidence: [evidence('identity', 'IDENTITY'), evidence('period', 'APPLICATION_PERIOD')],
  sourceRef: { source: 'BIZINFO', externalId: 'PBLN_SEONGDONG' },
  noticeTextChecksum: NOTICE_CHECKSUM,
};
const SEONGDONG_ONLY = {
  region: {
    status: 'READ',
    value: {
      scope: 'SEOUL_DISTRICTS',
      provinces: ['서울'],
      districts: ['성동구'],
      excludedProvinces: [],
      excludedDistricts: [],
      districtCodes: ['11200'],
      excludedDistrictCodes: [],
    },
    quote: '성동구 소재 소상공인',
  },
};

type PlanRow = { id: string; revision: number; fundingProfileJson: unknown; businessProfileJson: unknown };

// 계획·활성 릴리스·추출 결과 조회만 흉내 내는 Prisma 대역. 맞춰 보기는 실제 코드가 한다.
function stubPrisma(plan: PlanRow | null, active = true) {
  const findPlan = vi.fn().mockResolvedValue(plan);
  const findRelease = vi.fn().mockResolvedValue(
    active
      ? {
          id: 'release-1',
          catalogKey: 'test-catalog',
          catalogVersion: '2026-11-03.1',
          schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
          basisDate: new Date('2026-11-03T00:00:00.000Z'),
          activatedAt: new Date('2026-11-03T03:00:00.000Z'),
          // 출처 확인을 오늘로 둬 최신성 보류가 결과를 가리지 않게 한다.
          automation: {
            blockedSources: [],
            sourceSyncs: [
              {
                source: 'BIZINFO',
                status: 'SUCCEEDED',
                attemptedAt: '2026-11-03T03:00:00.000Z',
                lastSucceededOn: todayInKst(),
                fetchedCount: 1,
                responseChecksum: null,
                failureReason: null,
              },
            ],
          },
          products: [{ position: 0, productVersion: { productJson: PRODUCT } }],
        }
      : null,
  );
  const findExtractions = vi
    .fn()
    .mockResolvedValue([{ productKey: PRODUCT.productKey, textChecksum: NOTICE_CHECKSUM, fields: SEONGDONG_ONLY }]);
  return {
    prisma: {
      plan: { findFirst: findPlan },
      fundingCatalogRelease: { findFirst: findRelease },
      fundingConditionExtraction: { findMany: findExtractions },
    },
    findPlan,
    findRelease,
  };
}

const context = { params: Promise.resolve({ planId: 'plan-a' }) };
const planRow = (fundingProfileJson: unknown, businessProfileJson: unknown = null, revision = 1): PlanRow => ({
  id: 'plan-a',
  revision,
  fundingProfileJson,
  businessProfileJson,
});
const matchRequest = () => new Request('http://localhost/api/plans/plan-a/funding-matches', { method: 'POST' });
const jsonRequest = (body: unknown, method = 'POST') =>
  new Request('http://localhost/api/plans', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function matchesFor(plan: PlanRow): Promise<PlanFundingMatchesResponse> {
  mocks.getPrisma.mockReturnValue(stubPrisma(plan).prisma);
  const response = await postMatches(matchRequest(), context);
  expect(response.status).toBe(200);
  return (await response.json()) as PlanFundingMatchesResponse;
}

const regionOf = (body: PlanFundingMatchesResponse) =>
  body.tabs.SUPPORT_PROGRAM.products[0]?.conditions.find((entry) => entry.key === 'region')?.verdict;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ id: 'user-a', email: 'a@example.com' });
});

describe('POST /api/plans/{planId}/funding-matches 경계', () => {
  it('미로그인 요청을 401로 차단하고 계획을 조회하지 않는다', async () => {
    mocks.currentUser.mockResolvedValue(null);
    const response = await postMatches(matchRequest(), context);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('없거나 다른 사용자 소유인 계획은 403이 아니라 404로 숨긴다', async () => {
    const stub = stubPrisma(null);
    mocks.getPrisma.mockReturnValue(stub.prisma);
    const response = await postMatches(matchRequest(), context);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
    expect(stub.findPlan).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'plan-a', userId: 'user-a' } }));
    expect(stub.findRelease).not.toHaveBeenCalled();
  });

  it('저장된 자금 조건이 없으면 맞춰 보지 않고 400이다', async () => {
    // 사업 프로필의 자치구만으로 조건 없는 계획을 맞춰 보지 않는다. 자치구는 저장된 자금 조건을 보충할 때만 쓴다.
    const stub = stubPrisma(planRow(null, BUSINESS_PROFILE_JSON));
    mocks.getPrisma.mockReturnValue(stub.prisma);
    const response = await postMatches(matchRequest(), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_INPUT');
    expect(stub.findRelease).not.toHaveBeenCalled();
  });

  it('저장된 자금 조건이 지금 모양과 예전 모양 어디에도 맞지 않으면 400이다', async () => {
    for (const stored of [
      { businessStage: 'REGISTERED', districtCode: null, industryCode: null, purpose: 'UNKNOWN' },
      { ...PROFILE, age: 35.5 },
      { ...PROFILE, asOfDate: '2000-01-01' },
      'PRE_REGISTRATION',
    ]) {
      const stub = stubPrisma(planRow(stored));
      mocks.getPrisma.mockReturnValue(stub.prisma);
      const response = await postMatches(matchRequest(), context);
      expect(response.status, JSON.stringify(stored)).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
      expect(stub.findRelease).not.toHaveBeenCalled();
    }
  });

  it('활성 카탈로그 릴리스가 없으면 503 CATALOG_UNAVAILABLE이다', async () => {
    mocks.getPrisma.mockReturnValue(stubPrisma(planRow(PROFILE), false).prisma);
    const response = await postMatches(matchRequest(), context);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('CATALOG_UNAVAILABLE');
  });

  it('저장된 조건으로 맞춰 보고 계획·revision과 맞춰 본 입력을 함께 돌려준다', async () => {
    const dayBefore = todayInKst();
    const body = await matchesFor(planRow(PROFILE, null, 3));
    const dayAfter = todayInKst();
    expect(body.plan).toEqual({ id: 'plan-a', revision: 3 });
    expect(body.profile).toEqual(PROFILE);
    expect(body.districtSource).toBe('FUNDING_PROFILE');
    expect(body.release.catalogKey).toBe('test-catalog');
    // 판정 기준일은 서버의 한국 시간 오늘이며 요청으로 바꿀 수 없다.
    expect([dayBefore, dayAfter]).toContain(body.asOfDate);
    expect(regionOf(body)).toBe('MATCH');
  });

  it('예전 모양의 조건은 사업 단계와 자치구만 옮겨 맞춰 본다', async () => {
    const body = await matchesFor(planRow(LEGACY_PROFILE));
    expect(body.profile).toEqual({
      businessStatus: 'BUSINESS',
      openedYearMonth: null,
      districtCode: '11200',
      age: null,
      targetGroups: null,
    });
    expect(body.profile).not.toHaveProperty('industryCode');
    expect(body.profile).not.toHaveProperty('purpose');
    expect(regionOf(body)).toBe('MATCH');
  });

  it('자금 조건의 자치구가 비어 있으면 서버가 사업 프로필의 자치구로 맞춰 본다', async () => {
    // ADR §4. 사업 프로필은 마포구라 성동구 한정 공고와 안 맞는다.
    const body = await matchesFor(planRow({ ...PROFILE, districtCode: null }, BUSINESS_PROFILE_JSON));
    expect(body.profile.districtCode).toBe('11440');
    expect(body.districtSource).toBe('BUSINESS_PROFILE');
    expect(regionOf(body)).toBe('MISMATCH');
    // 안 맞아도 숨기지 않는다.
    expect(body.tabs.SUPPORT_PROGRAM.products[0]?.group).toBe('NOT_MATCHING');
  });

  it('자금 조건의 자치구가 있으면 사업 프로필보다 그것을 쓴다', async () => {
    const body = await matchesFor(planRow(PROFILE, BUSINESS_PROFILE_JSON));
    expect(body.profile.districtCode).toBe('11200');
    expect(body.districtSource).toBe('FUNDING_PROFILE');
    expect(regionOf(body)).toBe('MATCH');
  });

  it('어디에도 자치구가 없으면 지역은 입력이 없는 확인 필요다', async () => {
    const body = await matchesFor(planRow({ ...PROFILE, districtCode: null }));
    expect(body.districtSource).toBeNull();
    const region = body.tabs.SUPPORT_PROGRAM.products[0]?.conditions.find((entry) => entry.key === 'region');
    expect(region).toMatchObject({ verdict: 'CHECK', checkReason: 'INPUT_MISSING' });
  });
});

describe('계획 저장의 자금 조건', () => {
  function createStub() {
    let created: Record<string, unknown> | undefined;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created = structuredClone(data);
      return { id: 'plan-a', ...data };
    });
    mocks.getPrisma.mockReturnValue({ plan: { create } });
    return { create, created: () => created };
  }

  it('POST /api/plans가 보낸 자금 조건을 그대로 저장한다', async () => {
    const stub = createStub();
    const response = await createPlan(jsonRequest({ title: 'A', input, fundingProfile: PROFILE }));
    expect(response.status).toBe(201);
    expect(stub.created()?.fundingProfileJson).toEqual(PROFILE);
    // 재무 입력 스키마 버전은 자금 조건으로 바뀌지 않는다.
    expect(stub.created()?.inputSchemaVersion).toBe('finance-input-v1.0.0');
  });

  it('자금 조건 없이 만든 계획은 조건 없는 계획으로 저장한다', async () => {
    const stub = createStub();
    expect((await createPlan(jsonRequest({ title: 'A', input }))).status).toBe(201);
    expect(stub.created()).toHaveProperty('fundingProfileJson');
    expect(stub.created()?.fundingProfileJson).not.toEqual(PROFILE);
  });

  it('자금 조건이 잘못되거나 예전 모양이면 400으로 거부하고 계획을 만들지 않는다', async () => {
    // 예전 모양은 읽을 때만 바꾼다. 새로 쓰는 값은 지금 모양이어야 한다.
    const stub = createStub();
    for (const fundingProfile of [
      LEGACY_PROFILE,
      { ...PROFILE, age: 34.5 },
      { ...PROFILE, businessStatus: 'BUSINESS', openedYearMonth: '2024-13' },
      { ...PROFILE, openedYearMonth: '2024-03' },
      'PRE_STARTUP',
    ]) {
      const response = await createPlan(jsonRequest({ title: 'A', input, fundingProfile }));
      expect(response.status, JSON.stringify(fundingProfile)).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
    }
    expect(stub.create).not.toHaveBeenCalled();
  });

  it('PUT /api/plans/{planId}가 조건을 보내면 저장하고, 보내지 않으면 기존 값을 유지한다', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      plan: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'plan-a', revision: 2 }),
        findFirst: vi.fn(),
      },
    };
    mocks.getPrisma.mockReturnValue({
      plan: { findFirst: vi.fn().mockResolvedValue({ loanAssumptionJson: null }) },
      $transaction: (callback: (value: typeof tx) => unknown) => callback(tx),
    });

    const business = { ...PROFILE, businessStatus: 'BUSINESS', openedYearMonth: '2024-03' };
    await updatePlan(jsonRequest({ title: 'A', input, fundingProfile: business, revision: 1 }, 'PUT'), context);
    expect(updateMany.mock.calls[0][0].data.fundingProfileJson).toEqual(business);

    await updatePlan(jsonRequest({ title: 'A', input, revision: 1 }, 'PUT'), context);
    expect(updateMany.mock.calls[1][0].data).not.toHaveProperty('fundingProfileJson');
  });

  it('조건 없는 기존 계획도 수정 요청에서 유효하고 revision 규칙은 그대로다', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const tx = {
      plan: { updateMany, findUniqueOrThrow: vi.fn(), findFirst: vi.fn().mockResolvedValue({ revision: 5 }) },
    };
    mocks.getPrisma.mockReturnValue({
      plan: { findFirst: vi.fn().mockResolvedValue({ loanAssumptionJson: null }) },
      $transaction: (callback: (value: typeof tx) => unknown) => callback(tx),
    });
    const response = await updatePlan(jsonRequest({ title: 'A', input, revision: 1 }, 'PUT'), context);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('REVISION_CONFLICT');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL에서 저장된 계획 조건으로 맞춰 보기', () => {
  let client: PrismaClient | null = null;
  let startedAt = new Date(0);
  let previousActiveId: string | null = null;
  const USER_ID = 'test-plan-funding-user';
  const REAL_CATALOG_PATH = fileURLToPath(new URL('../../../catalog/funding/catalog.json', import.meta.url));
  const sourceCatalog = JSON.parse(readFileSync(REAL_CATALOG_PATH, 'utf8')) as {
    products: Array<Record<string, unknown> & { productKey: string }>;
  };

  function writeCatalogFile(value: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'trendbench-plan-funding-'));
    CREATED_DIRS.push(dir);
    const path = join(dir, 'catalog.json');
    writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
    return path;
  }

  // 실제 카탈로그 5건을 productKey만 바꿔 적재한다. 추출 결과는 넣지 않는다.
  const CATALOG_PATH = writeCatalogFile({
    ...sourceCatalog,
    catalogKey: 'test-plan-funding-catalog',
    products: sourceCatalog.products.map((product) => ({
      ...product,
      productKey: 'test-plan-funding-' + product.productKey,
    })),
  });

  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    await db().plan.deleteMany({ where: { userId: USER_ID } });
    await db().user.deleteMany({ where: { id: USER_ID } });
    await db().user.create({ data: { id: USER_ID, name: '계획 조건 테스트', email: 'test-plan-funding@example.com' } });

    const staleReleases = await db().fundingCatalogRelease.findMany({
      where: { catalogKey: { startsWith: 'test-plan-funding' } },
      select: { id: true },
    });
    if (staleReleases.length > 0) {
      const staleIds = staleReleases.map((release) => release.id);
      await db().fundingCatalogProduct.deleteMany({ where: { catalogReleaseId: { in: staleIds } } });
      await db().fundingCatalogRelease.deleteMany({ where: { id: { in: staleIds } } });
    }
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-plan-funding-' } } });

    const baseline = await db().fundingCatalogRelease.findFirst({
      where: { catalogKey: { not: { startsWith: 'test-plan-funding' } }, status: { in: ['ACTIVE', 'SUPERSEDED'] } },
      orderBy: { activatedAt: 'desc' },
    });
    if (baseline) {
      await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
      await db().fundingCatalogRelease.update({ where: { id: baseline.id }, data: { status: 'ACTIVE' } });
    }
    startedAt = new Date();
    previousActiveId = (await db().fundingCatalogRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;

    const report = await loadFundingCatalog({
      catalogPath: CATALOG_PATH,
      prisma: db(),
      asOfDate: LOAD_DATE,
      log: () => {},
    });
    expect(report.outcome).toBe('ACTIVATED');
  });

  afterAll(async () => {
    await db().plan.deleteMany({ where: { userId: USER_ID } });
    await db().user.deleteMany({ where: { id: USER_ID } });
    const releases = await db().fundingCatalogRelease.findMany({ where: { createdAt: { gte: startedAt } } });
    for (const release of releases) await db().fundingCatalogRelease.delete({ where: { id: release.id } });
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-plan-funding-' } } });
    if (previousActiveId) {
      const previous = await db().fundingCatalogRelease.findUnique({ where: { id: previousActiveId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
        await db().fundingCatalogRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
  });

  beforeEach(() => {
    mocks.currentUser.mockResolvedValue({ id: USER_ID, email: 'test-plan-funding@example.com' });
    mocks.getPrisma.mockReturnValue(db());
  });

  async function createStoredPlan(fundingProfile?: unknown): Promise<{ id: string; revision: number }> {
    const body =
      fundingProfile === undefined
        ? { title: '자금 조건 계획', input }
        : { title: '자금 조건 계획', input, fundingProfile };
    const response = await createPlan(jsonRequest(body));
    expect(response.status).toBe(201);
    return (await response.json()).plan;
  }

  const shownCount = (body: PlanFundingMatchesResponse) =>
    body.tabs.POLICY_FUND.products.length + body.tabs.SUPPORT_PROGRAM.products.length;

  it('저장된 조건으로 맞춰 보고, 조건 수정이 다음 조회에 반영된다', async () => {
    const created = await createStoredPlan(PROFILE);
    const planContext = { params: Promise.resolve({ planId: created.id }) };
    const before = await postMatches(matchRequest(), planContext);
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as PlanFundingMatchesResponse;
    expect(beforeBody.plan).toEqual({ id: created.id, revision: 1 });
    // 차단 목록이 비어 있으니 릴리스의 상품이 모두 보인다(AI 값으로 빼지 않는다).
    expect(beforeBody.release.productCount).toBe(5);
    expect(shownCount(beforeBody)).toBe(5);
    expect(beforeBody.hiddenCount).toBe(0);
    // 추출 결과가 없으면 AI가 읽을 항목이 모두 읽지 않음이라 맞아 보이는 공고가 없다.
    expect(beforeBody.tabs.POLICY_FUND.counts.MATCHING + beforeBody.tabs.SUPPORT_PROGRAM.counts.MATCHING).toBe(0);

    const next = { ...PROFILE, businessStatus: 'BUSINESS', openedYearMonth: '2024-03' };
    const update = await updatePlan(
      jsonRequest({ title: '자금 조건 계획', input, fundingProfile: next, revision: created.revision }, 'PUT'),
      planContext,
    );
    expect(update.status).toBe(200);
    expect((await update.json()).plan.fundingProfileJson).toEqual(next);

    const afterBody = (await (await postMatches(matchRequest(), planContext)).json()) as PlanFundingMatchesResponse;
    expect(afterBody.plan.revision).toBe(created.revision + 1);
    expect(afterBody.profile).toEqual(next);

    // 자금 조건 수정은 저장된 계산 결과를 만들거나 바꾸지 않는다.
    expect(await db().planResult.count({ where: { planId: created.id } })).toBe(0);
  });

  it('예전 모양으로 저장된 조건은 읽을 때 바꾸고, 다음 저장 때 지금 모양으로 쓴다', async () => {
    const created = await createStoredPlan(PROFILE);
    await db().plan.update({ where: { id: created.id }, data: { fundingProfileJson: LEGACY_PROFILE } });
    const planContext = { params: Promise.resolve({ planId: created.id }) };

    const body = (await (await postMatches(matchRequest(), planContext)).json()) as PlanFundingMatchesResponse;
    expect(body.profile).toEqual({
      businessStatus: 'BUSINESS',
      openedYearMonth: null,
      districtCode: '11200',
      age: null,
      targetGroups: null,
    });
    // 읽기는 저장된 값을 바꾸지 않는다.
    expect((await db().plan.findUniqueOrThrow({ where: { id: created.id } })).fundingProfileJson).toEqual(
      LEGACY_PROFILE,
    );

    const saved = await updatePlan(
      jsonRequest({ title: '자금 조건 계획', input, fundingProfile: body.profile, revision: created.revision }, 'PUT'),
      planContext,
    );
    expect(saved.status).toBe(200);
    expect((await db().plan.findUniqueOrThrow({ where: { id: created.id } })).fundingProfileJson).toEqual(body.profile);
  });

  it('조건 없이 만든 계획은 조회가 400이고, 조건을 null로 보내면 비운다', async () => {
    const legacy = await createStoredPlan();
    const legacyContext = { params: Promise.resolve({ planId: legacy.id }) };
    expect((await postMatches(matchRequest(), legacyContext)).status).toBe(400);
    const titleOnly = await updatePlan(
      jsonRequest({ title: '제목만 수정', input, revision: legacy.revision }, 'PUT'),
      legacyContext,
    );
    expect(titleOnly.status).toBe(200);
    expect((await titleOnly.json()).plan.fundingProfileJson).toBeNull();

    const created = await createStoredPlan(PROFILE);
    const planContext = { params: Promise.resolve({ planId: created.id }) };
    expect((await postMatches(matchRequest(), planContext)).status).toBe(200);
    const cleared = await updatePlan(
      jsonRequest({ title: '자금 조건 계획', input, fundingProfile: null, revision: created.revision }, 'PUT'),
      planContext,
    );
    expect(cleared.status).toBe(200);
    expect((await db().plan.findUniqueOrThrow({ where: { id: created.id } })).fundingProfileJson).toBeNull();
    const after = await postMatches(matchRequest(), planContext);
    expect(after.status).toBe(400);
    expect((await after.json()).error.code).toBe('INVALID_INPUT');
  });
});

afterAll(() => {
  for (const dir of CREATED_DIRS) rmSync(dir, { recursive: true, force: true });
});
