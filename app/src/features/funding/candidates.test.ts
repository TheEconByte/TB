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

import { POST as postCandidates } from '@/app/api/funding/candidates/route';
import { listFundingCandidates, type FundingCandidatesResponse } from './candidates.ts';
import { loadFundingCatalog } from './loader.ts';
import { findActiveFundingCatalog } from './read.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from './types.ts';
import type { FundingProfile } from './eligibility.ts';

const TEST_DATE = '2026-09-20';
const FAR_FUTURE = '2099-01-01';
const REAL_CATALOG_PATH = fileURLToPath(new URL('../../../catalog/funding/catalog.json', import.meta.url));
const CREATED_DIRS: string[] = [];
const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';

function writeCatalogFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'trendbench-candidates-'));
  CREATED_DIRS.push(dir);
  const path = join(dir, 'catalog.json');
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  return path;
}

function evidence(id: string, subject: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    subject,
    summary: '공식 원문에서 해당 조건을 확인했습니다.',
    sourceUrl: OFFICIAL_URL,
    sourceDocumentName: '테스트 공고문',
    observedAt: TEST_DATE,
    retrievalMethod: 'OFFICIAL_WEB_PAGE',
    checksum: null,
    ...overrides,
  };
}

// 판정에 필요한 근거를 모두 공식 원문(OFFICIAL_WEB_PAGE)으로 채운 기본 상품.
const BASE_PRODUCT: Record<string, unknown> = {
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

function rawProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_PRODUCT, ...overrides };
}

// Prisma가 돌려주는 연결 행 모양(position + 불변 상품 버전)을 그대로 흉내 낸다.
type StubMembership = { position: number; productVersion: { productJson: unknown } };

type StubReleaseInput = {
  catalogVersion?: string;
  basisDate?: string;
  reviewer?: string;
  products: StubMembership[];
};

// 활성 릴리스 조회만 흉내 내는 Prisma 대역. 정렬·판정 로직은 실제 코드가 수행한다.
function stubPrisma(release: StubReleaseInput | null) {
  const findFirst = vi.fn().mockResolvedValue(
    release === null
      ? null
      : {
          id: 'release-1',
          catalogKey: 'test-catalog',
          catalogVersion: release.catalogVersion ?? '2026-09-20.1',
          schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
          basisDate: new Date(`${release.basisDate ?? TEST_DATE}T00:00:00.000Z`),
          reviewedAt: new Date(`${TEST_DATE}T00:00:00.000Z`),
          activatedAt: new Date('2026-09-20T03:00:00.000Z'),
          reviewer: release.reviewer ?? 'test-reviewer',
          products: release.products,
        },
  );
  return { prisma: { fundingCatalogRelease: { findFirst } } as unknown as PrismaClient, findFirst };
}

function membership(product: Record<string, unknown>, position: number): StubMembership {
  return { position, productVersion: { productJson: product } };
}

const PRE_PROFILE: FundingProfile = {
  businessStage: 'PRE_REGISTRATION',
  districtCode: '11200',
  industryCode: 'CS100010',
  purpose: 'OPERATING_FUNDS',
};

const POST_PROFILE: FundingProfile = { ...PRE_PROFILE, businessStage: 'POST_REGISTRATION' };

async function candidatesOf(
  prisma: PrismaClient,
  profile: FundingProfile = PRE_PROFILE,
  asOfDate: string = TEST_DATE,
): Promise<FundingCandidatesResponse> {
  const outcome = await listFundingCandidates(prisma, profile, { asOfDate });
  if (outcome.kind !== 'OK') throw new Error('활성 카탈로그가 없습니다.');
  return outcome.payload;
}

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/api/funding/candidates', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  businessStage: 'PRE_REGISTRATION',
  districtCode: '11200',
  industryCode: 'CS100010',
  purpose: 'OPERATING_FUNDS',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ id: 'user-a', email: 'a@example.com' });
});

describe('POST /api/funding/candidates 경계', () => {
  it('미로그인 요청을 401로 차단하고 카탈로그를 조회하지 않는다', async () => {
    mocks.currentUser.mockResolvedValue(null);
    const response = await postCandidates(jsonRequest(VALID_BODY));
    expect(response.status).toBe(401);
    expect(mocks.getPrisma).not.toHaveBeenCalled();
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('잘못된 프로필을 400으로 거부한다', async () => {
    const invalidBodies: unknown[] = [
      {},
      { ...VALID_BODY, businessStage: 'REGISTERED' },
      { ...VALID_BODY, purpose: 'TRAVEL' },
      { ...VALID_BODY, districtCode: '1120' },
      { ...VALID_BODY, industryCode: 'cs100010' },
      { ...VALID_BODY, districtCode: 11200 },
    ];
    for (const body of invalidBodies) {
      const response = await postCandidates(jsonRequest(body));
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
    }
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('본문으로 판정 기준일(asOfDate)을 지정할 수 없다', async () => {
    const response = await postCandidates(jsonRequest({ ...VALID_BODY, asOfDate: '2000-01-01' }));
    expect(response.status).toBe(400);
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('활성 카탈로그 릴리스가 없으면 503 CATALOG_UNAVAILABLE이다', async () => {
    mocks.getPrisma.mockReturnValue(stubPrisma(null).prisma);
    const response = await postCandidates(jsonRequest(VALID_BODY));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('CATALOG_UNAVAILABLE');
  });

  it('조건이 모두 충족되고 접수 중이면 검토 후보 1건을 반환한다', async () => {
    mocks.getPrisma.mockReturnValue(stubPrisma({ products: [membership(rawProduct(), 0)] }).prisma);
    const response = await postCandidates(jsonRequest(VALID_BODY));
    expect(response.status).toBe(200);
    const body = (await response.json()) as FundingCandidatesResponse;
    expect(body.catalogKey).toBe('test-catalog');
    expect(body.catalogVersion).toBe('2026-09-20.1');
    expect(body.basisDate).toBe(TEST_DATE);
    expect(body.profile).toEqual(VALID_BODY);
    expect(body.release.reviewer).toBe('test-reviewer');
    expect(body.release.schemaVersion).toBe(FUNDING_CATALOG_SCHEMA_VERSION);
    expect(body.summary.CURRENT_CANDIDATE).toBe(1);
    expect(body.evaluations).toHaveLength(1);
    const [evaluation] = body.evaluations;
    expect(evaluation).toMatchObject({
      name: '테스트 대출 상품',
      organization: '테스트 기관',
      supportType: 'LOAN',
      candidateStatus: 'CURRENT_CANDIDATE',
      officialUrl: OFFICIAL_URL,
      reviewState: 'CURRENT',
    });
    expect(evaluation.conditions.map((condition) => condition.verdict)).toEqual(['PASS', 'PASS', 'PASS', 'PASS']);
  });
});

describe('후보 판정과 응답', () => {
  it('연결 테이블 position 순서를 보존한다', async () => {
    const { prisma } = stubPrisma({
      products: [
        membership(rawProduct({ productKey: 'test-third', name: '세 번째' }), 2),
        membership(rawProduct({ productKey: 'test-first', name: '첫 번째' }), 0),
        membership(rawProduct({ productKey: 'test-second', name: '두 번째' }), 1),
      ],
    });
    const payload = await candidatesOf(prisma);
    expect(payload.evaluations.map((evaluation) => evaluation.productKey)).toEqual([
      'test-first',
      'test-second',
      'test-third',
    ]);
  });

  it('FAIL과 UNKNOWN이 함께 있으면 조건 미충족으로 분류한다', async () => {
    const { prisma } = stubPrisma({
      products: [
        membership(
          rawProduct({
            region: { scope: 'DISTRICTS', districtCodes: ['11110'], note: null },
            industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: '업종 매핑 미검수' },
          }),
          0,
        ),
      ],
    });
    const payload = await candidatesOf(prisma);
    const [evaluation] = payload.evaluations;
    const verdicts = new Map(evaluation.conditions.map((condition) => [condition.key, condition.verdict]));
    expect(verdicts.get('REGION')).toBe('FAIL');
    expect(verdicts.get('INDUSTRY')).toBe('UNKNOWN');
    expect(evaluation.eligibilityVerdict).toBe('FAIL');
    expect(evaluation.candidateStatus).toBe('NOT_ELIGIBLE');
    expect(payload.summary.NOT_ELIGIBLE).toBe(1);
  });

  it('FAIL 없이 UNKNOWN만 있으면 추가 확인으로 분류한다', async () => {
    const { prisma } = stubPrisma({
      products: [
        membership(
          rawProduct({
            industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: '업종 매핑 미검수' },
          }),
          0,
        ),
      ],
    });
    const payload = await candidatesOf(prisma);
    expect(payload.evaluations[0].eligibilityVerdict).toBe('UNKNOWN');
    expect(payload.evaluations[0].candidateStatus).toBe('NEEDS_CONFIRMATION');
    expect(payload.summary.CURRENT_CANDIDATE).toBe(0);
  });

  it('검수자가 지정되지 않은 상품은 검토 후보가 되지 않는다', async () => {
    const { prisma } = stubPrisma({ products: [membership(rawProduct({ reviewer: 'UNASSIGNED' }), 0)] });
    const payload = await candidatesOf(prisma);
    const [evaluation] = payload.evaluations;
    expect(evaluation.observedApplicationStatus).toBe('OPEN');
    expect(evaluation.reviewState).toBe('UNREVIEWED');
    expect(evaluation.candidateStatus).toBe('NEEDS_CONFIRMATION');
    expect(evaluation.candidateReason).toContain('검수자가 지정되지 않아');
    expect(payload.summary.CURRENT_CANDIDATE).toBe(0);
  });

  it('종료된 공고는 접수 종료로 분리한다', async () => {
    const { prisma } = stubPrisma({
      products: [
        membership(
          rawProduct({
            observedApplicationStatus: 'CLOSED',
            applicationPeriod: { start: '2026-03-01', end: '2026-03-26', note: null },
          }),
          0,
        ),
      ],
    });
    const payload = await candidatesOf(prisma);
    expect(payload.evaluations[0].candidateStatus).toBe('CLOSED');
    expect(payload.summary.CLOSED).toBe(1);
    expect(payload.summary.CURRENT_CANDIDATE).toBe(0);
  });

  it('검수 기한이 지난 상품은 접수 중이어도 검수 기한 경과로 분리한다', async () => {
    const { prisma } = stubPrisma({
      products: [
        membership(rawProduct({ observedAt: '2026-09-10', reviewedAt: '2026-09-10', nextReviewAt: '2026-09-16' }), 0),
      ],
    });
    const payload = await candidatesOf(prisma);
    const [evaluation] = payload.evaluations;
    expect(evaluation.observedApplicationStatus).toBe('OPEN');
    expect(evaluation.reviewState).toBe('REVIEW_OVERDUE');
    expect(evaluation.candidateStatus).toBe('REVIEW_OVERDUE');
    expect(payload.summary.REVIEW_OVERDUE).toBe(1);
    expect(payload.summary.CURRENT_CANDIDATE).toBe(0);
  });

  it('사업자등록 이후 전용 상품을 현재 후보와 분리한다', async () => {
    const postOnly = rawProduct({ eligibleBusinessStages: ['POST_REGISTRATION'] });
    const { prisma } = stubPrisma({ products: [membership(postOnly, 0)] });

    const pre = await candidatesOf(prisma, PRE_PROFILE);
    expect(pre.evaluations[0].audience).toBe('POST_REGISTRATION_ONLY');
    expect(pre.evaluations[0].candidateStatus).toBe('POST_REGISTRATION');
    expect(pre.summary.POST_REGISTRATION).toBe(1);
    expect(pre.summary.CURRENT_CANDIDATE).toBe(0);

    const post = await candidatesOf(prisma, POST_PROFILE);
    expect(post.evaluations[0].candidateStatus).toBe('CURRENT_CANDIDATE');
    expect(post.summary.POST_REGISTRATION).toBe(0);
  });

  it('검토 후보가 하나도 없으면 후보 0건을 정상 응답으로 반환한다', async () => {
    const { prisma } = stubPrisma({
      products: [
        membership(
          rawProduct({
            productKey: 'test-closed-a',
            observedApplicationStatus: 'CLOSED',
            applicationPeriod: { start: '2026-03-01', end: '2026-03-26', note: null },
          }),
          0,
        ),
        membership(
          rawProduct({
            productKey: 'test-closed-b',
            observedApplicationStatus: 'CLOSED',
            applicationPeriod: { start: '2026-03-01', end: '2026-03-26', note: null },
          }),
          1,
        ),
      ],
    });
    const payload = await candidatesOf(prisma);
    expect(payload.summary.total).toBe(2);
    expect(payload.summary.CURRENT_CANDIDATE).toBe(0);
    expect(payload.summary.CLOSED).toBe(2);
    expect(payload.evaluations).toHaveLength(2);
  });

  it('연결된 상품이 없는 활성 릴리스는 빈 후보로 응답한다', async () => {
    const { prisma } = stubPrisma({ products: [] });
    const payload = await candidatesOf(prisma);
    expect(payload.evaluations).toEqual([]);
    expect(payload.summary.total).toBe(0);
    expect(payload.summary.CURRENT_CANDIDATE).toBe(0);
  });

  it('판정 기준일을 주입하면 검수 기한 판정이 그 날짜를 따른다', async () => {
    const { prisma } = stubPrisma({
      products: [membership(rawProduct({ reviewedAt: TEST_DATE, nextReviewAt: '2026-10-20' }), 0)],
    });
    const before = await candidatesOf(prisma, PRE_PROFILE, TEST_DATE);
    expect(before.evaluations[0].candidateStatus).toBe('CURRENT_CANDIDATE');
    const after = await candidatesOf(prisma, PRE_PROFILE, '2026-10-21');
    expect(after.evaluations[0].candidateStatus).toBe('REVIEW_OVERDUE');
    expect(after.asOfDate).toBe('2026-10-21');
  });

  it('지원금·공간·프로그램을 상환 가능 대출로 노출하지 않는다', async () => {
    const { prisma } = stubPrisma({
      products: [
        membership(
          rawProduct({
            productKey: 'test-grant',
            supportType: 'GRANT',
            repaymentMethod: 'NOT_APPLICABLE',
            publicLimit: null,
            unsupportedCalculationReasons: ['지원금은 대출 원금·상환 일정으로 변환하지 않습니다.'],
          }),
          0,
        ),
        membership(
          rawProduct({
            productKey: 'test-space',
            supportType: 'SPACE',
            repaymentMethod: 'NOT_APPLICABLE',
            publicLimit: null,
            unsupportedCalculationReasons: ['공간 지원은 대출 원금·상환 일정으로 변환하지 않습니다.'],
          }),
          1,
        ),
        membership(rawProduct({ productKey: 'test-loan-unconfirmed' }), 2),
      ],
    });
    const payload = await candidatesOf(prisma);
    for (const evaluation of payload.evaluations) {
      expect(evaluation.repayment.supported).toBe(false);
      expect(evaluation.repayment.publicLimitKrw).toBeNull();
      expect(evaluation.repayment.terms).toBeNull();
      expect(evaluation.repayment.reasons.length).toBeGreaterThan(0);
    }
    const grant = payload.evaluations.find((evaluation) => evaluation.productKey === 'test-grant');
    expect(grant?.repayment.reasons.join(' ')).toMatch(/대출 원금|상환 일정/);
    expect(grant?.repayment.note).toContain('상환 계산 대상이 아닙니다');
  });

  it('확정 조건이 있는 대출만 상환 계산 가능으로 표시한다', async () => {
    const { prisma } = stubPrisma({
      products: [
        membership(
          rawProduct({
            repaymentMethod: 'EQUAL_INSTALLMENT',
            interestCondition: '연 3% 고정',
            interestRateConfirmed: true,
            interestRatePercent: '3',
            repaymentCondition: '5년 원리금균등, 거치 없음',
            repaymentTermMonths: 60,
            repaymentGraceMonths: 0,
            unsupportedCalculationReasons: [],
          }),
          0,
        ),
        // 금리만 확정되고 상환기간·거치가 확인되지 않은 대출은 여전히 대상이 아니다.
        membership(
          rawProduct({
            productKey: 'test-loan-terms-unknown',
            repaymentMethod: 'EQUAL_INSTALLMENT',
            interestCondition: '연 3% 고정',
            interestRateConfirmed: true,
            interestRatePercent: '3',
            repaymentCondition: null,
            unsupportedCalculationReasons: ['상환기간·거치 조건이 확인되지 않았습니다.'],
          }),
          1,
        ),
      ],
    });
    const payload = await candidatesOf(prisma);
    expect(payload.evaluations[0].repayment).toMatchObject({
      supported: true,
      publicLimitKrw: '50000000',
      terms: {
        annualInterestRatePercent: '3',
        totalMonths: 60,
        graceMonths: 0,
        repaymentMethod: 'EQUAL_INSTALLMENT',
      },
    });
    expect(payload.evaluations[1].repayment).toMatchObject({ supported: false, publicLimitKrw: null, terms: null });
    expect(payload.evaluations[1].repayment.reasons.join(' ')).toContain('상환기간');
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL에서 활성 카탈로그 후보 조회', () => {
  let client: PrismaClient | null = null;
  let startedAt = new Date(0);
  let previousActiveId: string | null = null;
  const sourceCatalog = JSON.parse(readFileSync(REAL_CATALOG_PATH, 'utf8')) as {
    products: Array<Record<string, unknown> & { productKey: string }>;
  };
  const SOURCE_ORDER = sourceCatalog.products.map((product) => `test-${product.productKey}`);
  const REVIEWED_CATALOG_PATH = writeCatalogFile({
    ...sourceCatalog,
    catalogKey: 'test-candidates-catalog',
    reviewer: 'test-reviewer',
    products: sourceCatalog.products.map((product) => ({
      ...product,
      productKey: `test-${product.productKey}`,
      reviewer: 'test-reviewer',
    })),
  });

  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    const staleReleases = await db().fundingCatalogRelease.findMany({
      where: { catalogKey: { startsWith: 'test-' } },
      select: { id: true },
    });
    if (staleReleases.length > 0) {
      const staleIds = staleReleases.map((release) => release.id);
      await db().fundingCatalogProduct.deleteMany({ where: { catalogReleaseId: { in: staleIds } } });
      await db().fundingCatalogRelease.deleteMany({ where: { id: { in: staleIds } } });
    }
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-' } } });
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

    const report = await loadFundingCatalog({
      catalogPath: REVIEWED_CATALOG_PATH,
      prisma: db(),
      asOfDate: TEST_DATE,
      log: () => {},
    });
    expect(report.outcome).toBe('ACTIVATED');
  });

  afterAll(async () => {
    const releases = await db().fundingCatalogRelease.findMany({ where: { createdAt: { gte: startedAt } } });
    for (const release of releases) await db().fundingCatalogRelease.delete({ where: { id: release.id } });
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-' } } });
    if (previousActiveId) {
      const previous = await db().fundingCatalogRelease.findUnique({ where: { id: previousActiveId } });
      if (previous && previous.status !== 'ACTIVE') {
        await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
        await db().fundingCatalogRelease.update({ where: { id: previousActiveId }, data: { status: 'ACTIVE' } });
      }
    }
    await db().$disconnect();
  });

  it('활성 릴리스의 상품 버전을 position 순서로 조회한다', async () => {
    const active = await findActiveFundingCatalog(db());
    expect(active).not.toBeNull();
    expect(active?.catalogKey).toBe('test-candidates-catalog');
    expect(active?.schemaVersion).toBe(FUNDING_CATALOG_SCHEMA_VERSION);
    expect(active?.basisDate).toBe(TEST_DATE);
    expect(active?.productCount).toBe(5);
    expect(active?.catalog.products.map((product) => product.productKey)).toEqual(SOURCE_ORDER);
  });

  it('검수자가 지정된 카탈로그에서 예비 창업자 후보를 상태별로 나눈다', async () => {
    const payload = await candidatesOf(db(), PRE_PROFILE, TEST_DATE);
    expect(payload.summary.total).toBe(5);
    expect(payload.summary.CURRENT_CANDIDATE).toBe(0);
    expect(payload.summary.CLOSED).toBe(1);
    expect(payload.summary.POST_REGISTRATION).toBe(3);
    expect(payload.summary.REVIEW_OVERDUE).toBe(1);
    expect(payload.evaluations.map((evaluation) => evaluation.productKey)).toEqual(SOURCE_ORDER);
    for (const evaluation of payload.evaluations) {
      expect(evaluation.repayment.supported).toBe(false);
    }
  });

  it('사업자등록 이후 프로필에서는 등록 이후 검토 상품이 추가 확인으로 바뀐다', async () => {
    const payload = await candidatesOf(db(), POST_PROFILE, TEST_DATE);
    expect(payload.summary.POST_REGISTRATION).toBe(0);
    expect(payload.summary.NEEDS_CONFIRMATION).toBe(3);
    expect(payload.summary.CURRENT_CANDIDATE).toBe(0);
  });

  it('활성 릴리스가 없으면 CATALOG_UNAVAILABLE을 반환한다', async () => {
    await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
    const outcome = await listFundingCandidates(db(), PRE_PROFILE, { asOfDate: TEST_DATE });
    expect(outcome.kind).toBe('CATALOG_UNAVAILABLE');
    await db().fundingCatalogRelease.updateMany({
      where: { catalogKey: 'test-candidates-catalog' },
      data: { status: 'ACTIVE' },
    });
  });
});

afterAll(() => {
  for (const dir of CREATED_DIRS) rmSync(dir, { recursive: true, force: true });
});
