import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '../../generated/prisma/client.ts';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getPrisma: vi.fn() }));
vi.mock('@/lib/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }));

import { POST as applyLoanAssumption } from '@/app/api/plans/[planId]/loan-assumption/route';
import { POST as createPlan } from '@/app/api/plans/route';
import { PUT as updatePlan } from '@/app/api/plans/[planId]/route';
import { POST as calculatePlan } from '@/app/api/plans/[planId]/calculations/route';
import { GET as getResult } from '@/app/api/plans/[planId]/results/[resultId]/route';
import { calculateFinance } from '@/features/finance/calculate.ts';
import { financeInputSchema } from '@/features/finance/schema.ts';
import type { FinanceInput } from '@/features/finance/types';
import { assessProductRepayment } from '@/features/funding/eligibility.ts';
import { loadFundingCatalog } from '@/features/funding/loader.ts';
import { fundingProductSchema } from '@/features/funding/schema.ts';
import { FUNDING_CATALOG_SCHEMA_VERSION } from '@/features/funding/types.ts';
import {
  loanAssumptionFromProduct,
  planLoanAssumptionSchema,
  retainedLoanAssumption,
  type PlanLoanAssumption,
} from '@/features/plans/loan-assumption.ts';

const TEST_DATE = '2026-09-20';
const FAR_FUTURE = '2099-01-01';
const APPLIED_AT = '2026-09-21T00:00:00.000Z';
const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';
const CATALOG = { catalogKey: 'test-catalog', catalogVersion: '2026-09-20.1' };
const CREATED_DIRS: string[] = [];

// F1 검산 예제와 같은 개업 전 자금·운영 가정. 신규 대출만 상품 확정 조건으로 바뀐다.
const input: FinanceInput = {
  openingExpenses: {
    deposit: '30000000',
    facilities: '40000000',
    initialInventory: '5000000',
    otherPreparation: '5000000',
  },
  targetReserve: '10000000',
  equity: '40000000',
  monthlyRevenue: '20000000',
  monthlyFixedCosts: { rent: '3000000', labor: '3000000', other: '1000000' },
  variableCostRate: '0.35',
  existingMonthlyDebtPayment: '0',
  newLoan: {
    principal: '10000000',
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

// 확정 조건이 모두 있는 대출. 상환 계산 대상으로 인정되는 최소 조건을 갖춘다.
const CONFIRMED_TERMS: Record<string, unknown> = {
  interestCondition: '연 3% 고정',
  interestRateConfirmed: true,
  interestRatePercent: '3',
  repaymentCondition: '60개월 원리금균등, 거치 없음',
  repaymentMethod: 'EQUAL_INSTALLMENT',
  repaymentTermMonths: 60,
  repaymentGraceMonths: 0,
  unsupportedCalculationReasons: [],
};

function rawProduct(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_PRODUCT, ...overrides };
}

function parsedProduct(overrides: Record<string, unknown> = {}) {
  return fundingProductSchema.parse(rawProduct(overrides));
}

function confirmedProduct(overrides: Record<string, unknown> = {}) {
  return parsedProduct({ ...CONFIRMED_TERMS, ...overrides });
}

function writeCatalogFile(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'trendbench-loan-assumption-'));
  CREATED_DIRS.push(dir);
  const path = join(dir, 'catalog.json');
  writeFileSync(path, JSON.stringify(value, null, 2), 'utf8');
  return path;
}

type Membership = { position: number; productVersion: { productJson: unknown } };

function membership(product: Record<string, unknown>, position: number): Membership {
  return { position, productVersion: { productJson: product } };
}

function releaseRow(products: Membership[]) {
  return {
    id: 'release-1',
    catalogKey: 'test-catalog',
    catalogVersion: '2026-09-20.1',
    schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
    basisDate: new Date(`${TEST_DATE}T00:00:00.000Z`),
    reviewedAt: new Date(`${TEST_DATE}T00:00:00.000Z`),
    activatedAt: new Date('2026-09-20T03:00:00.000Z'),
    reviewer: 'test-reviewer',
    productCount: products.length,
    products,
  };
}

const context = { params: Promise.resolve({ planId: 'plan-a' }) };
const planContext = (planId: string) => ({ params: Promise.resolve({ planId }) });
const jsonRequest = (body: unknown, method = 'POST') =>
  new Request('http://localhost/api/plans', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const applyRequest = (body: unknown) =>
  new Request('http://localhost/api/plans/plan-a/loan-assumption', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const STORED_ASSUMPTION: PlanLoanAssumption = {
  productKey: 'test-loan',
  version: '1.0.0',
  name: '테스트 대출 상품',
  catalogKey: CATALOG.catalogKey,
  catalogVersion: CATALOG.catalogVersion,
  appliedAt: APPLIED_AT,
  newLoan: {
    principal: '10000000',
    annualInterestRatePercent: '3',
    totalMonths: 60,
    graceMonths: 0,
    repaymentMethod: 'EQUAL_PAYMENT',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ id: 'user-a', email: 'a@example.com' });
});

describe('상품 확정 조건에서 대출 가정으로의 매핑', () => {
  it('사용자가 저장한 원금과 상품의 확정 금리·상환기간·거치를 결합한다', () => {
    expect(loanAssumptionFromProduct(confirmedProduct(), CATALOG, APPLIED_AT, '10000000')).toEqual({
      ...STORED_ASSUMPTION,
      newLoan: { ...STORED_ASSUMPTION.newLoan },
    });

    const equalPrincipal = loanAssumptionFromProduct(
      confirmedProduct({ repaymentMethod: 'EQUAL_PRINCIPAL' }),
      CATALOG,
      APPLIED_AT,
      '10000000',
    );
    expect(equalPrincipal?.newLoan.repaymentMethod).toBe('EQUAL_PRINCIPAL');
  });

  it('공개 한도를 원금으로 복사하지 않고 저장 원금이 한도를 넘으면 거부한다', () => {
    const valid = loanAssumptionFromProduct(
      confirmedProduct({ interestRatePercent: '0' }),
      CATALOG,
      APPLIED_AT,
      '10000000',
    );
    expect(valid?.newLoan).toEqual({
      principal: '10000000',
      annualInterestRatePercent: '0',
      totalMonths: 60,
      graceMonths: 0,
      repaymentMethod: 'EQUAL_PAYMENT',
    });
    expect(loanAssumptionFromProduct(confirmedProduct({ publicLimit: '0' }), CATALOG, APPLIED_AT, '1')).toBeNull();
  });

  it('미확정·미지원 조건이 하나라도 있으면 대출 가정을 만들지 않는다', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['지원금', { ...CONFIRMED_TERMS, supportType: 'GRANT', repaymentMethod: 'NOT_APPLICABLE' }],
      ['공개 한도 없음', { ...CONFIRMED_TERMS, publicLimit: null }],
      ['금리 미확정', { ...CONFIRMED_TERMS, interestRateConfirmed: false, interestRatePercent: null }],
      ['금리 숫자 없음', { ...CONFIRMED_TERMS, interestRatePercent: null }],
      ['상환방식 미지원', { ...CONFIRMED_TERMS, repaymentMethod: 'BULLET' }],
      ['상환기간 미확인', { ...CONFIRMED_TERMS, repaymentTermMonths: null }],
      ['거치 미확인', { ...CONFIRMED_TERMS, repaymentGraceMonths: null }],
      ['거치가 전체기간 이상', { ...CONFIRMED_TERMS, repaymentTermMonths: 12, repaymentGraceMonths: 12 }],
    ];
    for (const [label, overrides] of cases) {
      const repayment = assessProductRepayment(parsedProduct(overrides));
      expect(repayment.supported, label).toBe(false);
      expect(repayment.terms, label).toBeNull();
      expect(repayment.publicLimitKrw, label).toBeNull();
      expect(repayment.reasons.length, label).toBeGreaterThan(0);
      expect(loanAssumptionFromProduct(parsedProduct(overrides), CATALOG, APPLIED_AT, '10000000'), label).toBeNull();
    }
  });

  it('거치 0과 거치가 있는 조건 모두 F1 엔진에서 원금 합계와 최종 잔액을 맞춘다', () => {
    for (const repaymentMethod of ['EQUAL_INSTALLMENT', 'EQUAL_PRINCIPAL'] as const) {
      for (const repaymentGraceMonths of [0, 6]) {
        const assumption = loanAssumptionFromProduct(
          confirmedProduct({ repaymentMethod, repaymentGraceMonths }),
          CATALOG,
          APPLIED_AT,
          '10000000',
        );
        expect(assumption, `${repaymentMethod}/${repaymentGraceMonths}`).not.toBeNull();
        const result = calculateFinance({ ...input, newLoan: assumption!.newLoan });
        expect(result.loan.status).toBe('READY');
        if (result.loan.status !== 'READY') throw new Error('대출 일정을 계산하지 못했습니다.');
        const { schedule, totalPrincipal } = result.loan.value;
        expect(schedule).toHaveLength(60);
        expect(totalPrincipal).toBe('10000000');
        expect(schedule.at(-1)?.remainingPrincipal).toBe('0');
        // 원 단위 정수 문자열과 거치기간의 이자만 지급 규칙.
        for (const row of schedule) expect(row.payment).toMatch(/^\d+$/);
        for (const row of schedule.slice(0, repaymentGraceMonths)) {
          expect(row.phase).toBe('GRACE');
          expect(row.principal).toBe('0');
        }
      }
    }
  });

  it('저장된 가정과 신규 대출 입력이 같을 때만 출처를 유지한다', () => {
    expect(retainedLoanAssumption(STORED_ASSUMPTION, { ...STORED_ASSUMPTION.newLoan })).toEqual(STORED_ASSUMPTION);

    const changed: FinanceInput['newLoan'][] = [
      { ...STORED_ASSUMPTION.newLoan, principal: '20000000' },
      { ...STORED_ASSUMPTION.newLoan, annualInterestRatePercent: '5' },
      { ...STORED_ASSUMPTION.newLoan, totalMonths: 36 },
      { ...STORED_ASSUMPTION.newLoan, graceMonths: 6 },
      { ...STORED_ASSUMPTION.newLoan, repaymentMethod: 'EQUAL_PRINCIPAL' },
      { ...input.newLoan },
    ];
    for (const nextLoan of changed) expect(retainedLoanAssumption(STORED_ASSUMPTION, nextLoan)).toBeNull();

    expect(retainedLoanAssumption(null, { ...STORED_ASSUMPTION.newLoan })).toBeNull();
    expect(retainedLoanAssumption({ productKey: 'test-loan' }, { ...STORED_ASSUMPTION.newLoan })).toBeNull();
  });

  it('저장 스키마가 알 수 없는 키와 잘못된 원 단위 값을 거부한다', () => {
    expect(planLoanAssumptionSchema.safeParse(STORED_ASSUMPTION).success).toBe(true);
    expect(planLoanAssumptionSchema.safeParse({ ...STORED_ASSUMPTION, extra: true }).success).toBe(false);
    expect(
      planLoanAssumptionSchema.safeParse({
        ...STORED_ASSUMPTION,
        newLoan: { ...STORED_ASSUMPTION.newLoan, principal: '-1' },
      }).success,
    ).toBe(false);
    expect(
      planLoanAssumptionSchema.safeParse({
        ...STORED_ASSUMPTION,
        newLoan: { ...STORED_ASSUMPTION.newLoan, totalMonths: 0 },
      }).success,
    ).toBe(false);
  });

  // 파일만 읽으므로 DB 없이 돈다. CI(unit 모드)에서도 실제 카탈로그를 검사하려면 DB 묶음 밖에 둔다.
  it('실제 검수 카탈로그 5건은 모두 상환 계산 대상이 아니다', () => {
    const real = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../catalog/funding/catalog.json', import.meta.url)), 'utf8'),
    ) as {
      products: Array<Record<string, unknown>>;
    };
    expect(real.products).toHaveLength(5);
    for (const entry of real.products) {
      const repayment = assessProductRepayment(fundingProductSchema.parse(entry));
      expect(repayment.supported).toBe(false);
      expect(repayment.terms).toBeNull();
      expect(repayment.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('POST /api/plans/{planId}/loan-assumption 경계', () => {
  function stubApply(options: {
    plan?: unknown;
    products?: Membership[] | null;
    updateCount?: number;
    conflictRevision?: number;
    updated?: Record<string, unknown>;
  }) {
    const findPlan = vi.fn();
    findPlan.mockResolvedValueOnce(options.plan ?? null);
    if (options.conflictRevision !== undefined) findPlan.mockResolvedValueOnce({ revision: options.conflictRevision });
    const updateMany = vi.fn().mockResolvedValue({ count: options.updateCount ?? 1 });
    const findUniqueOrThrow = vi.fn().mockResolvedValue(options.updated ?? { id: 'plan-a', revision: 2 });
    const findRelease = vi.fn().mockResolvedValue(options.products ? releaseRow(options.products) : null);
    return {
      prisma: {
        plan: { findFirst: findPlan, updateMany, findUniqueOrThrow },
        fundingCatalogRelease: { findFirst: findRelease },
      } as unknown as PrismaClient,
      findPlan,
      updateMany,
      findRelease,
    };
  }

  const planRow = { id: 'plan-a', revision: 1, inputJson: input, fundingProfileJson: PRE_PROFILE };
  const body = { productKey: 'test-loan', version: '1.0.0', revision: 1 };
  const repayable = [membership(rawProduct(CONFIRMED_TERMS), 0)];
  const grantOnly = [
    membership(
      rawProduct({
        productKey: 'test-grant',
        supportType: 'GRANT',
        repaymentMethod: 'NOT_APPLICABLE',
        publicLimit: null,
        unsupportedCalculationReasons: ['지원금(사업화 자금)은 대출 원금·상환 일정으로 변환하지 않습니다.'],
      }),
      0,
    ),
  ];

  it('미로그인 요청을 401로 차단하고 계획을 조회하지 않는다', async () => {
    mocks.currentUser.mockResolvedValue(null);
    const response = await applyLoanAssumption(applyRequest(body), context);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHORIZED');
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('없거나 다른 사용자 소유인 계획은 404로 숨긴다', async () => {
    const stub = stubApply({ plan: null, products: repayable });
    mocks.getPrisma.mockReturnValue(stub.prisma);
    const response = await applyLoanAssumption(applyRequest(body), context);
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
    expect(stub.findPlan).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'plan-a', userId: 'user-a' } }));
    expect(stub.findRelease).not.toHaveBeenCalled();
  });

  it('잘못된 요청 본문을 400으로 거부한다', async () => {
    const bodies: unknown[] = [
      {},
      { productKey: 'test-loan' },
      { ...body, revision: 0 },
      { ...body, revision: '1' },
      { ...body, asOfDate: '2000-01-01' },
      'test-loan',
    ];
    for (const invalid of bodies) {
      const response = await applyLoanAssumption(applyRequest(invalid), context);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
    }
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });

  it('활성 카탈로그 릴리스가 없으면 503이다', async () => {
    const stub = stubApply({ plan: planRow, products: null });
    mocks.getPrisma.mockReturnValue(stub.prisma);
    const response = await applyLoanAssumption(applyRequest(body), context);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('CATALOG_UNAVAILABLE');
    expect(stub.updateMany).not.toHaveBeenCalled();
  });

  it('활성 카탈로그에 없는 상품 버전과 상환 계산 대상이 아닌 상품을 400으로 거부한다', async () => {
    const missing = stubApply({ plan: planRow, products: repayable });
    mocks.getPrisma.mockReturnValue(missing.prisma);
    const missingResponse = await applyLoanAssumption(applyRequest({ ...body, version: '9.9.9' }), context);
    expect(missingResponse.status).toBe(400);
    expect((await missingResponse.json()).error.message).toContain('찾을 수 없습니다');
    expect(missing.updateMany).not.toHaveBeenCalled();

    const grant = stubApply({ plan: planRow, products: grantOnly });
    mocks.getPrisma.mockReturnValue(grant.prisma);
    const grantResponse = await applyLoanAssumption(applyRequest({ ...body, productKey: 'test-grant' }), context);
    expect(grantResponse.status).toBe(400);
    const grantBody = await grantResponse.json();
    expect(grantBody.error.message).toContain('상환 계산 대상이 아니');
    expect(grantBody.error.message).toMatch(/대출 원금|상환 일정/);
    expect(grant.updateMany).not.toHaveBeenCalled();
  });

  it('상환 조건이 확정돼도 현재 계획의 CURRENT_CANDIDATE가 아니면 적용을 거부한다', async () => {
    const closed = stubApply({
      plan: planRow,
      products: [membership(rawProduct({ ...CONFIRMED_TERMS, observedApplicationStatus: 'CLOSED' }), 0)],
    });
    mocks.getPrisma.mockReturnValue(closed.prisma);

    const response = await applyLoanAssumption(applyRequest(body), context);

    expect(response.status).toBe(400);
    const payload = await response.json();
    expect(payload.error.code).toBe('INVALID_INPUT');
    expect(payload.error.message).toContain('CLOSED');
    expect(closed.updateMany).not.toHaveBeenCalled();
  });

  it('저장된 신규 대출금이 없거나 공개 한도를 넘으면 적용을 거부한다', async () => {
    for (const principal of ['0', '50000001']) {
      const plan = { ...planRow, inputJson: { ...input, newLoan: { ...input.newLoan, principal } } };
      const stub = stubApply({ plan, products: repayable });
      mocks.getPrisma.mockReturnValue(stub.prisma);

      const response = await applyLoanAssumption(applyRequest(body), context);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_INPUT');
      expect(stub.updateMany).not.toHaveBeenCalled();
    }
  });

  it('오래된 revision은 409이고 현재 revision을 알려준다', async () => {
    const stub = stubApply({ plan: planRow, products: repayable, updateCount: 0, conflictRevision: 4 });
    mocks.getPrisma.mockReturnValue(stub.prisma);
    const response = await applyLoanAssumption(applyRequest(body), context);
    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.error.code).toBe('REVISION_CONFLICT');
    expect(payload.error.fields).toEqual({ currentRevision: 4 });
  });

  it('적용하면 신규 대출 입력과 출처를 저장하고 revision을 올린다', async () => {
    const updated = { id: 'plan-a', revision: 2, inputJson: { ...input, newLoan: STORED_ASSUMPTION.newLoan } };
    const stub = stubApply({ plan: planRow, products: repayable, updated });
    mocks.getPrisma.mockReturnValue(stub.prisma);
    const response = await applyLoanAssumption(applyRequest(body), context);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.plan).toEqual(updated);
    expect(payload.loanAssumption).toMatchObject({
      productKey: 'test-loan',
      version: '1.0.0',
      catalogKey: 'test-catalog',
      catalogVersion: '2026-09-20.1',
      newLoan: STORED_ASSUMPTION.newLoan,
    });
    expect(payload.loanAssumption.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const call = stub.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'plan-a', userId: 'user-a', revision: 1 });
    expect(call.data.revision).toEqual({ increment: 1 });
    expect(call.data.inputJson).toEqual({ ...input, newLoan: STORED_ASSUMPTION.newLoan });
    expect(planLoanAssumptionSchema.safeParse(call.data.loanAssumptionJson).success).toBe(true);
  });

  it('저장된 초안 입력이 현재 스키마와 맞지 않으면 값을 만들지 않고 400이다', async () => {
    const stub = stubApply({ plan: { ...planRow, inputJson: { broken: true } }, products: repayable });
    mocks.getPrisma.mockReturnValue(stub.prisma);
    const response = await applyLoanAssumption(applyRequest(body), context);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toContain('스키마');
    expect(stub.updateMany).not.toHaveBeenCalled();
  });
});

describe('계획 수정과 계산의 대출 가정 출처', () => {
  function stubUpdate(stored: unknown) {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      plan: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'plan-a', revision: 2 }),
        findFirst: vi.fn(),
      },
    };
    mocks.getPrisma.mockReturnValue({
      plan: { findFirst: vi.fn().mockResolvedValue({ loanAssumptionJson: stored }) },
      $transaction: (callback: (value: typeof tx) => unknown) => callback(tx),
    });
    return updateMany;
  }

  it('신규 대출 입력이 같으면 상품 출처를 유지한다', async () => {
    const updateMany = stubUpdate(STORED_ASSUMPTION);
    const response = await updatePlan(
      jsonRequest({ title: 'A', input: { ...input, newLoan: STORED_ASSUMPTION.newLoan }, revision: 1 }, 'PUT'),
      context,
    );
    expect(response.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data.loanAssumptionJson).toEqual(STORED_ASSUMPTION);
  });

  it('사용자가 대출 값을 직접 바꾸면 상품 출처를 지운다', async () => {
    const updateMany = stubUpdate(STORED_ASSUMPTION);
    const response = await updatePlan(
      jsonRequest(
        {
          title: 'A',
          input: { ...input, newLoan: { ...STORED_ASSUMPTION.newLoan, principal: '20000000' } },
          revision: 1,
        },
        'PUT',
      ),
      context,
    );
    expect(response.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data.loanAssumptionJson).toBe(Prisma.DbNull);
  });

  it('저장된 상품 출처가 스키마와 맞지 않으면 지운다', async () => {
    const updateMany = stubUpdate({ productKey: 'test-loan' });
    await updatePlan(
      jsonRequest({ title: 'A', input: { ...input, newLoan: STORED_ASSUMPTION.newLoan }, revision: 1 }, 'PUT'),
      context,
    );
    expect(updateMany.mock.calls[0][0].data.loanAssumptionJson).toBe(Prisma.DbNull);
  });

  it('계산 결과에 그 revision의 상품 출처를 복사한다', async () => {
    let created: Record<string, unknown> | undefined;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created = data;
      return { id: 'result-a', ...data };
    });
    mocks.getPrisma.mockReturnValue({
      plan: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'plan-a',
          userId: 'user-a',
          revision: 2,
          inputSchemaVersion: 'finance-input-v1.0.0',
          inputJson: { ...input, newLoan: STORED_ASSUMPTION.newLoan },
          loanAssumptionJson: STORED_ASSUMPTION,
        }),
      },
      planResult: { findUnique: vi.fn().mockResolvedValue(null), create },
    });
    const response = await calculatePlan(new Request('http://localhost', { method: 'POST' }), context);
    expect(response.status).toBe(201);
    expect(created?.loanAssumptionJson).toEqual(STORED_ASSUMPTION);
  });

  it('저장된 상품 출처가 없으면 결과에도 남기지 않는다', async () => {
    let created: Record<string, unknown> | undefined;
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created = data;
      return { id: 'result-a', ...data };
    });
    mocks.getPrisma.mockReturnValue({
      plan: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'plan-a',
          userId: 'user-a',
          revision: 1,
          inputSchemaVersion: 'finance-input-v1.0.0',
          inputJson: input,
          loanAssumptionJson: null,
        }),
      },
      planResult: { findUnique: vi.fn().mockResolvedValue(null), create },
    });
    await calculatePlan(new Request('http://localhost', { method: 'POST' }), context);
    expect(created?.loanAssumptionJson).toBe(Prisma.DbNull);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL에서 상품 조건 적용과 결과 불변성', () => {
  let client: PrismaClient | null = null;
  let startedAt = new Date(0);
  let previousActiveId: string | null = null;
  const USER_ID = 'test-loan-assumption-user';
  const FULL_LOAN = (overrides: Record<string, unknown> = {}) => ({
    ...BASE_PRODUCT,
    ...CONFIRMED_TERMS,
    productKey: 'test-loan-assumption-loan',
    ...overrides,
  });

  const CATALOG_FILE = writeCatalogFile({
    catalogKey: 'test-loan-assumption-catalog',
    schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
    catalogVersion: '2026-09-21.1',
    basisDate: TEST_DATE,
    reviewer: 'test-reviewer',
    notes: [],
    products: [
      FULL_LOAN(),
      {
        ...BASE_PRODUCT,
        productKey: 'test-loan-assumption-grant',
        supportType: 'GRANT',
        repaymentMethod: 'NOT_APPLICABLE',
        publicLimit: null,
        unsupportedCalculationReasons: ['지원금(사업화 자금)은 대출 원금·상환 일정으로 변환하지 않습니다.'],
      },
    ],
  });

  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    await db().plan.deleteMany({ where: { userId: USER_ID } });
    await db().user.deleteMany({ where: { id: USER_ID } });
    await db().user.create({
      data: { id: USER_ID, name: '대출 가정 테스트', email: 'test-loan-assumption@example.com' },
    });

    const staleReleases = await db().fundingCatalogRelease.findMany({
      where: { catalogKey: { startsWith: 'test-loan-assumption' } },
      select: { id: true },
    });
    if (staleReleases.length > 0) {
      const staleIds = staleReleases.map((release) => release.id);
      await db().fundingCatalogProduct.deleteMany({ where: { catalogReleaseId: { in: staleIds } } });
      await db().fundingCatalogRelease.deleteMany({ where: { id: { in: staleIds } } });
    }
    await db().fundingCatalogProduct.deleteMany({
      where: { productVersion: { productKey: { startsWith: 'test-loan-assumption-' } } },
    });
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-loan-assumption-' } } });

    const baseline = await db().fundingCatalogRelease.findFirst({
      where: { catalogKey: { not: { startsWith: 'test-loan-assumption' } }, status: { in: ['ACTIVE', 'SUPERSEDED'] } },
      orderBy: { activatedAt: 'desc' },
    });
    if (baseline) {
      await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
      await db().fundingCatalogRelease.update({ where: { id: baseline.id }, data: { status: 'ACTIVE' } });
    }
    startedAt = new Date();
    previousActiveId = (await db().fundingCatalogRelease.findFirst({ where: { status: 'ACTIVE' } }))?.id ?? null;

    const report = await loadFundingCatalog({
      catalogPath: CATALOG_FILE,
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
    await db().fundingProductVersion.deleteMany({ where: { productKey: { startsWith: 'test-loan-assumption-' } } });
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
    mocks.currentUser.mockResolvedValue({ id: USER_ID, email: 'test-loan-assumption@example.com' });
    mocks.getPrisma.mockReturnValue(db());
  });

  async function createStoredPlan(): Promise<{ id: string; revision: number }> {
    const response = await createPlan(jsonRequest({ title: '대출 가정 계획', input, fundingProfile: PRE_PROFILE }));
    expect(response.status).toBe(201);
    return (await response.json()).plan;
  }

  it('상품 확정 조건을 적용하고 계산 결과에 출처를 남긴 뒤 직접 수정하면 출처만 지운다', async () => {
    const created = await createStoredPlan();
    const planContextFor = planContext(created.id);

    const applyBody = { productKey: 'test-loan-assumption-loan', version: '1.0.0', revision: created.revision };
    const applied = await applyLoanAssumption(applyRequest(applyBody), planContextFor);
    expect(applied.status).toBe(200);
    const appliedPayload = await applied.json();
    expect(appliedPayload.loanAssumption).toMatchObject({
      productKey: 'test-loan-assumption-loan',
      version: '1.0.0',
      catalogKey: 'test-loan-assumption-catalog',
      catalogVersion: '2026-09-21.1',
    });
    const stored = await db().plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.revision).toBe(created.revision + 1);
    const storedInput = financeInputSchema.parse(stored.inputJson);
    expect(storedInput.newLoan).toEqual(appliedPayload.loanAssumption.newLoan);
    expect(storedInput.newLoan).toEqual({
      principal: '10000000',
      annualInterestRatePercent: '3',
      totalMonths: 60,
      graceMonths: 0,
      repaymentMethod: 'EQUAL_PAYMENT',
    });
    expect(stored.loanAssumptionJson).toEqual(appliedPayload.loanAssumption);

    const calculated = await calculatePlan(new Request('http://localhost', { method: 'POST' }), planContextFor);
    expect(calculated.status).toBe(201);
    const calculatedPayload = await calculated.json();
    expect(calculatedPayload.result.loanAssumptionJson).toEqual(appliedPayload.loanAssumption);
    const resultJson = calculatedPayload.result.resultJson as {
      loan: { status: string; value: { schedule: unknown[]; totalPrincipal: string } };
    };
    expect(resultJson.loan.status).toBe('READY');
    expect(resultJson.loan.value.schedule).toHaveLength(60);
    expect(resultJson.loan.value.totalPrincipal).toBe('10000000');

    const detail = await getResult(new Request('http://localhost'), {
      params: Promise.resolve({ planId: created.id, resultId: calculatedPayload.result.id }),
    });
    expect((await detail.json()).result.loanAssumptionJson.productKey).toBe('test-loan-assumption-loan');

    const before = await db().planResult.findUniqueOrThrow({ where: { id: calculatedPayload.result.id } });
    const manualLoan = {
      principal: '12000000',
      annualInterestRatePercent: '5',
      totalMonths: 24,
      graceMonths: 0,
      repaymentMethod: 'EQUAL_PAYMENT' as const,
    };
    const manual = await updatePlan(
      jsonRequest(
        {
          title: '대출 가정 계획',
          input: { ...input, newLoan: manualLoan },
          fundingProfile: PRE_PROFILE,
          revision: stored.revision,
        },
        'PUT',
      ),
      planContextFor,
    );
    expect(manual.status).toBe(200);
    const afterPlan = await db().plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(afterPlan.revision).toBe(stored.revision + 1);
    expect(financeInputSchema.parse(afterPlan.inputJson).newLoan).toEqual(manualLoan);
    expect(afterPlan.loanAssumptionJson).toBeNull();

    // 상품 조건을 적용한 과거 결과는 그대로 남는다.
    const after = await db().planResult.findUniqueOrThrow({ where: { id: calculatedPayload.result.id } });
    expect(after.resultJson).toEqual(before.resultJson);
    expect(after.loanAssumptionJson).toEqual(before.loanAssumptionJson);
    expect(after.inputSnapshot).toEqual(before.inputSnapshot);
  });

  it('신규 대출 입력이 그대로면 수정 저장에서도 상품 출처를 유지한다', async () => {
    const created = await createStoredPlan();
    const planContextFor = planContext(created.id);
    await applyLoanAssumption(
      applyRequest({ productKey: 'test-loan-assumption-loan', version: '1.0.0', revision: created.revision }),
      planContextFor,
    );
    const applied = await db().plan.findUniqueOrThrow({ where: { id: created.id } });
    const appliedInput = financeInputSchema.parse(applied.inputJson);

    const response = await updatePlan(
      jsonRequest(
        { title: '제목만 수정', input: appliedInput, fundingProfile: PRE_PROFILE, revision: applied.revision },
        'PUT',
      ),
      planContextFor,
    );
    expect(response.status).toBe(200);
    const updated = await db().plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(updated.loanAssumptionJson).toEqual(applied.loanAssumptionJson);
  });

  it('지원금 상품은 적용을 거부하고 활성 카탈로그가 없으면 503이다', async () => {
    const created = await createStoredPlan();
    const planContextFor = planContext(created.id);

    const grant = await applyLoanAssumption(
      applyRequest({ productKey: 'test-loan-assumption-grant', version: '1.0.0', revision: created.revision }),
      planContextFor,
    );
    expect(grant.status).toBe(400);
    expect((await grant.json()).error.code).toBe('INVALID_INPUT');

    await db().fundingCatalogRelease.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'SUPERSEDED' } });
    const unavailable = await applyLoanAssumption(
      applyRequest({ productKey: 'test-loan-assumption-loan', version: '1.0.0', revision: created.revision }),
      planContextFor,
    );
    expect(unavailable.status).toBe(503);
    await db().fundingCatalogRelease.updateMany({
      where: { catalogKey: 'test-loan-assumption-catalog' },
      data: { status: 'ACTIVE' },
    });

    const untouched = await db().plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(untouched.revision).toBe(created.revision);
    expect(untouched.loanAssumptionJson).toBeNull();
  });
});

afterAll(() => {
  for (const dir of CREATED_DIRS) rmSync(dir, { recursive: true, force: true });
});
