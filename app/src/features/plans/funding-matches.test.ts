import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getPrisma: vi.fn() }));
vi.mock('@/lib/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }));

import { POST as postMatches } from '@/app/api/plans/[planId]/funding-matches/route';
import { POST as createPlan } from '@/app/api/plans/route';
import { PUT as updatePlan } from '@/app/api/plans/[planId]/route';
import { todayInKst } from '@/features/funding/dates.ts';
import { loadFundingCatalog } from '@/features/funding/loader.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from '@/features/funding/types.ts';
import type { FinanceInput } from '@/features/finance/types';

const TEST_DATE = '2026-09-20';
const FAR_FUTURE = '2099-01-01';
const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';
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

const PRE_PROFILE = {
  businessStage: 'PRE_REGISTRATION',
  districtCode: '11200',
  industryCode: 'CS100010',
  purpose: 'OPERATING_FUNDS',
};
const POST_PROFILE = { ...PRE_PROFILE, businessStage: 'POST_REGISTRATION' };

function evidence(id: string, subject: string): Record<string, unknown> {
  return {
    id,
    subject,
    summary: '공식 원문에서 해당 조건을 확인했습니다.',
    sourceUrl: OFFICIAL_URL,
    sourceDocumentName: '테스트 공고문',
    observedAt: TEST_DATE,
    retrievalMethod: 'OFFICIAL_WEB_PAGE',
    checksum: null,
  };
}

// 판정에 필요한 근거를 모두 공식 원문으로 채운 상품. 판정 함수만 검증하므로
// 적재기 규칙 검사는 거치지 않는다.
const PRODUCT: Record<string, unknown> = {
  productKey: 'test-loan',
  version: '1.0.0',
  name: '테스트 대출 상품',
  organization: '테스트 기관',
  supportType: 'LOAN',
  eligibleBusinessStages: ['PRE_REGISTRATION'],
  region: { scope: 'SEOUL', districtCodes: [], note: null },
  purpose: { included: ['OPERATING_FUNDS'], excluded: [], note: null },
  industryConditions: { scope: 'UNRESTRICTED', included: [], excluded: [], note: null },
  applicationPeriod: { start: '2026-09-01', end: '2026-12-31', note: null },
  observedApplicationStatus: 'OPEN',
  observedAt: TEST_DATE,
  reviewedAt: TEST_DATE,
  nextReviewAt: FAR_FUTURE,
  officialUrl: OFFICIAL_URL,
  sourceDocumentName: '테스트 공고문',
  sourceDocumentRetrieved: false,
  sourceChecksum: null,
  publicLimit: '50000000',
  interestCondition: null,
  interestRateConfirmed: false,
  repaymentCondition: null,
  repaymentMethod: 'UNKNOWN',
  unsupportedCalculationReasons: ['금리가 확정되지 않았습니다.'],
  additionalChecks: [],
  reviewer: 'test-reviewer',
  evidence: [
    evidence('identity', 'IDENTITY'),
    evidence('period', 'APPLICATION_PERIOD'),
    evidence('stage', 'BUSINESS_STAGE'),
    evidence('financial', 'FINANCIAL_CONDITION'),
    evidence('region', 'REGION'),
    evidence('purpose', 'PURPOSE'),
    evidence('industry', 'INDUSTRY'),
  ],
};

type Membership = { position: number; productVersion: { productJson: unknown } };

const PRE_MEMBERSHIP: Membership = { position: 0, productVersion: { productJson: PRODUCT } };
const POST_ONLY_MEMBERSHIP: Membership = {
  position: 0,
  productVersion: { productJson: { ...PRODUCT, eligibleBusinessStages: ['POST_REGISTRATION'] } },
};

function releaseRow(products: Membership[]) {
  return {
    id: 'release-1',
    catalogKey: 'test-catalog',
    catalogVersion: '2026-09-20.1',
    schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
    basisDate: new Date(TEST_DATE + 'T00:00:00.000Z'),
    reviewedAt: new Date(TEST_DATE + 'T00:00:00.000Z'),
    activatedAt: new Date('2026-09-20T03:00:00.000Z'),
    reviewer: 'test-reviewer',
    products,
  };
}

// 계획 조회와 활성 릴리스 조회만 흉내 내는 Prisma 대역. 판정 로직은 실제 코드가 수행한다.
function stubPrisma(
  plan: { id: string; revision: number; fundingProfileJson: unknown } | null,
  products: Membership[] | null,
) {
  const findPlan = vi.fn().mockResolvedValue(plan);
  const findRelease = vi.fn().mockResolvedValue(products === null ? null : releaseRow(products));
  return {
    getPrisma: () => ({ plan: { findFirst: findPlan }, fundingCatalogRelease: { findFirst: findRelease } }),
    findPlan,
    findRelease,
  };
}

const context = { params: Promise.resolve({ planId: 'plan-a' }) };
const planRow = (fundingProfileJson: unknown, revision = 1) => ({ id: 'plan-a', revision, fundingProfileJson });
const matchRequest = () => new Request('http://localhost/api/plans/plan-a/funding-matches', { method: 'POST' });
const jsonRequest = (body: unknown, method = 'POST') =>
  new Request('http://localhost/api/plans', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

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
    const stub = stubPrisma(null, [PRE_MEMBERSHIP]);
    mocks.getPrisma.mockReturnValue(stub.getPrisma());
    const response = await postMatches(matchRequest(), context);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
    expect(stub.findPlan).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'plan-a', userId: 'user-a' } }));
    expect(stub.findRelease).not.toHaveBeenCalled();
  });

  it('저장된 프로필이 없으면 후보를 판정하지 않고 400이다', async () => {
    const stub = stubPrisma(planRow(null), [PRE_MEMBERSHIP]);
    mocks.getPrisma.mockReturnValue(stub.getPrisma());
    const response = await postMatches(matchRequest(), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_INPUT');
    expect(stub.findRelease).not.toHaveBeenCalled();
  });

  it('저장된 프로필이 현재 스키마와 맞지 않으면 400이다', async () => {
    const invalidProfiles: unknown[] = [
      { businessStage: 'REGISTERED', districtCode: null, industryCode: null, purpose: 'UNKNOWN' },
      { businessStage: 'PRE_REGISTRATION', districtCode: '1120', industryCode: null, purpose: 'UNKNOWN' },
      {
        businessStage: 'PRE_REGISTRATION',
        districtCode: null,
        industryCode: null,
        purpose: 'UNKNOWN',
        asOfDate: '2000-01-01',
      },
      { businessStage: 'PRE_REGISTRATION', districtCode: null, industryCode: null },
    ];
    for (const stored of invalidProfiles) {
      const stub = stubPrisma(planRow(stored), [PRE_MEMBERSHIP]);
      mocks.getPrisma.mockReturnValue(stub.getPrisma());
      const response = await postMatches(matchRequest(), context);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
      expect(stub.findRelease).not.toHaveBeenCalled();
    }
  });

  it('활성 카탈로그 릴리스가 없으면 503 CATALOG_UNAVAILABLE이다', async () => {
    const stub = stubPrisma(planRow(PRE_PROFILE), null);
    mocks.getPrisma.mockReturnValue(stub.getPrisma());
    const response = await postMatches(matchRequest(), context);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('CATALOG_UNAVAILABLE');
  });

  it('저장된 프로필로 판정하고 계획·revision 식별 정보를 함께 반환한다', async () => {
    const stub = stubPrisma(planRow(PRE_PROFILE, 3), [PRE_MEMBERSHIP]);
    mocks.getPrisma.mockReturnValue(stub.getPrisma());
    const response = await postMatches(matchRequest(), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.plan).toEqual({ id: 'plan-a', revision: 3 });
    expect(body.profile).toEqual(PRE_PROFILE);
    expect(body.catalogKey).toBe('test-catalog');
    expect(body.summary.CURRENT_CANDIDATE).toBe(1);
    expect(body.evaluations).toHaveLength(1);
    // 판정 기준일은 서버의 한국 시간 오늘이며 요청 본문으로 바꿀 수 없다.
    expect(body.asOfDate).toBe(todayInKst());
  });

  it('상품이 사업자등록 이후 전용이면 저장된 단계에 따라 분류가 달라진다', async () => {
    const pre = stubPrisma(planRow(PRE_PROFILE), [POST_ONLY_MEMBERSHIP]);
    mocks.getPrisma.mockReturnValue(pre.getPrisma());
    const preBody = await (await postMatches(matchRequest(), context)).json();
    expect(preBody.summary.POST_REGISTRATION).toBe(1);
    expect(preBody.summary.CURRENT_CANDIDATE).toBe(0);

    const post = stubPrisma(planRow(POST_PROFILE), [POST_ONLY_MEMBERSHIP]);
    mocks.getPrisma.mockReturnValue(post.getPrisma());
    const postBody = await (await postMatches(matchRequest(), context)).json();
    expect(postBody.summary.POST_REGISTRATION).toBe(0);
    expect(postBody.summary.CURRENT_CANDIDATE).toBe(1);
  });
});

describe('계획 저장의 자금 조건', () => {
  it('POST /api/plans가 보낸 자금 조건을 그대로 저장한다', async () => {
    let created: Record<string, unknown> | undefined;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created = structuredClone(data);
      return { id: 'plan-a', ...data };
    });
    mocks.getPrisma.mockReturnValue({ plan: { create } });
    const response = await createPlan(jsonRequest({ title: 'A', input, fundingProfile: PRE_PROFILE }));
    expect(response.status).toBe(201);
    expect(created?.fundingProfileJson).toEqual(PRE_PROFILE);
    // 재무 입력 스키마 버전은 자금 조건 추가로 바뀌지 않는다.
    expect(created?.inputSchemaVersion).toBe('finance-input-v1.0.0');
  });

  it('자금 조건 없이 만든 계획은 프로필 없는 계획으로 저장한다', async () => {
    let created: Record<string, unknown> | undefined;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created = structuredClone(data);
      return { id: 'plan-a', ...data };
    });
    mocks.getPrisma.mockReturnValue({ plan: { create } });
    expect((await createPlan(jsonRequest({ title: 'A', input }))).status).toBe(201);
    expect(created).toHaveProperty('fundingProfileJson');
    expect(created?.fundingProfileJson).not.toEqual(PRE_PROFILE);
  });

  it('자금 조건이 잘못되면 400으로 거부하고 계획을 만들지 않는다', async () => {
    const create = vi.fn();
    mocks.getPrisma.mockReturnValue({ plan: { create } });
    for (const fundingProfile of [
      { ...PRE_PROFILE, purpose: 'TRAVEL' },
      { ...PRE_PROFILE, districtCode: '1120' },
      'PRE_REGISTRATION',
    ]) {
      const response = await createPlan(jsonRequest({ title: 'A', input, fundingProfile }));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
    }
    expect(create).not.toHaveBeenCalled();
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

    await updatePlan(jsonRequest({ title: 'A', input, fundingProfile: POST_PROFILE, revision: 1 }, 'PUT'), context);
    expect(updateMany.mock.calls[0][0].data.fundingProfileJson).toEqual(POST_PROFILE);

    await updatePlan(jsonRequest({ title: 'A', input, revision: 1 }, 'PUT'), context);
    expect(updateMany.mock.calls[1][0].data).not.toHaveProperty('fundingProfileJson');
  });

  it('프로필 없는 기존 계획도 수정 요청에서 유효하고 revision 규칙은 그대로다', async () => {
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

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL에서 저장된 계획 조건 판정', () => {
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

  // 검수자가 지정된 합성 카탈로그. 실제 검수 카탈로그 5건을 그대로 쓰되 productKey와
  // 검수자만 바꿔 적재 규칙을 통과한 상품만 판정에 쓴다.
  const REVIEWED_CATALOG_PATH = writeCatalogFile({
    ...sourceCatalog,
    catalogKey: 'test-plan-funding-catalog',
    reviewer: 'test-reviewer',
    products: sourceCatalog.products.map((product) => ({
      ...product,
      productKey: 'test-plan-funding-' + product.productKey,
      reviewer: 'test-reviewer',
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
      catalogPath: REVIEWED_CATALOG_PATH,
      prisma: db(),
      asOfDate: TEST_DATE,
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

  it('저장된 프로필로 판정하고 프로필 수정이 다음 조회에 반영된다', async () => {
    const created = await createStoredPlan(PRE_PROFILE);
    const planContext = { params: Promise.resolve({ planId: created.id }) };
    const before = await postMatches(matchRequest(), planContext);
    expect(before.status).toBe(200);
    const beforeBody = await before.json();
    expect(beforeBody.plan).toEqual({ id: created.id, revision: 1 });
    expect(beforeBody.summary.total).toBe(5);
    expect(beforeBody.summary.POST_REGISTRATION).toBe(3);
    expect(beforeBody.summary.CURRENT_CANDIDATE).toBe(0);

    const update = await updatePlan(
      jsonRequest({ title: '자금 조건 계획', input, fundingProfile: POST_PROFILE, revision: created.revision }, 'PUT'),
      planContext,
    );
    expect(update.status).toBe(200);
    expect((await update.json()).plan.fundingProfileJson).toEqual(POST_PROFILE);

    const after = await postMatches(matchRequest(), planContext);
    const afterBody = await after.json();
    expect(afterBody.plan.revision).toBe(created.revision + 1);
    expect(afterBody.profile).toEqual(POST_PROFILE);
    expect(afterBody.summary.POST_REGISTRATION).toBe(0);
    expect(afterBody.summary.NEEDS_CONFIRMATION).toBe(3);

    // 자금 조건 수정은 저장된 계산 결과를 만들거나 바꾸지 않는다.
    expect(await db().planResult.count({ where: { planId: created.id } })).toBe(0);
  });

  it('프로필 없이 만든 기존 계획은 조회가 400이고 같은 계획의 다른 요청은 그대로 동작한다', async () => {
    const legacy = await createStoredPlan();
    const planContext = { params: Promise.resolve({ planId: legacy.id }) };
    const response = await postMatches(matchRequest(), planContext);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_INPUT');

    const fetched = await db().plan.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(fetched.fundingProfileJson).toBeNull();
    expect(fetched.revision).toBe(legacy.revision);

    const update = await updatePlan(
      jsonRequest({ title: '제목만 수정', input, revision: legacy.revision }, 'PUT'),
      planContext,
    );
    expect(update.status).toBe(200);
    expect((await update.json()).plan.fundingProfileJson).toBeNull();
  });

  it('조건을 null로 보내면 저장된 조건을 비우고 다음 조회는 400이 된다', async () => {
    const created = await createStoredPlan(PRE_PROFILE);
    const planContext = { params: Promise.resolve({ planId: created.id }) };
    expect((await postMatches(matchRequest(), planContext)).status).toBe(200);

    const cleared = await updatePlan(
      jsonRequest({ title: '자금 조건 계획', input, fundingProfile: null, revision: created.revision }, 'PUT'),
      planContext,
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).plan.fundingProfileJson).toBeNull();

    const fetched = await db().plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(fetched.fundingProfileJson).toBeNull();
    const after = await postMatches(matchRequest(), planContext);
    expect(after.status).toBe(400);
    expect((await after.json()).error.code).toBe('INVALID_INPUT');
  });
});

afterAll(() => {
  for (const dir of CREATED_DIRS) rmSync(dir, { recursive: true, force: true });
});
