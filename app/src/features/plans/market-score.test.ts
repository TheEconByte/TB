import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceInput } from '@/features/finance/types';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getPrisma: vi.fn() }));
vi.mock('@/lib/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }));

import { POST as createPlan } from '@/app/api/plans/route';
import { PUT as updatePlan } from '@/app/api/plans/[planId]/route';
import { parsePlanMarketScore } from '@/features/plans/market-score';

const input: FinanceInput = {
  openingExpenses: { deposit: '10', facilities: '20', initialInventory: null, otherPreparation: '0' },
  targetReserve: '5',
  equity: '15',
  monthlyRevenue: '29684576',
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
const reference = {
  releaseKey: 'market-score-v3-20262-20262-abc123',
  areaType: 'A',
  areaCode: '3110020',
  industryCode: 'CS100001',
};
const request = (body: unknown, method = 'POST') =>
  new Request('http://localhost/api/plans', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function prismaWith(
  overrides: { releaseStatus?: string; rowStatus?: string; monthly?: string; interpretation?: string } = {},
) {
  const create = vi.fn(async ({ data }) => ({ id: 'plan-a', revision: 1, ...data }));
  return {
    create,
    prisma: {
      marketScoreRelease: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'score-release',
          releaseKey: reference.releaseKey,
          status: overrides.releaseStatus ?? 'ACTIVE',
          modelVersion: 'market-score-v3-20262',
          marketReleaseId: 'market-release',
          marketReleaseKey: 'seoul-market-2021q1-2026q2-x',
          baseQuarter: '20262',
          summaryJson: {
            ...(overrides.interpretation === undefined
              ? {}
              : { monthlyRevenueInterpretation: overrides.interpretation }),
            industries: [
              { industryCode: 'CS100001', monthlyRevenueWarningRange: { low: '1000000', high: '189115558' } },
            ],
          },
        }),
      },
      marketScore: {
        findUnique: vi.fn().mockResolvedValue({
          status: overrides.rowStatus ?? 'SCORED',
          score: 48,
          grade: 'B',
          monthlyRevenueDefault: new Decimal(overrides.monthly ?? '29684576'),
        }),
      },
      marketArea: {
        findUnique: vi.fn().mockResolvedValue({
          areaType: 'A',
          areaCode: '3110020',
          sourceName: '서울국제고등학교',
          districtCode: '11110',
          districtName: '종로구',
        }),
      },
      plan: { create },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ id: 'user-a', email: 'a@example.com' });
});

describe('상권 점수에서 시작한 계획 저장', () => {
  it('화면이 보낸 등급이 아니라 점수 릴리스의 값으로 스냅샷을 저장한다', async () => {
    const { prisma, create } = prismaWith();
    mocks.getPrisma.mockReturnValue(prisma);
    const response = await createPlan(
      request({ title: '계획', input, marketScore: { ...reference, grade: 'AAA', score: 99 } }),
    );
    expect(response.status).toBe(201);
    const snapshot = parsePlanMarketScore(create.mock.calls[0][0].data.marketScoreJson);
    expect(snapshot).toMatchObject({
      releaseKey: reference.releaseKey,
      modelVersion: 'market-score-v3-20262',
      areaName: '서울국제고등학교',
      districtCode: '11110',
      industryName: '한식',
      score: 48,
      grade: 'B',
      monthlyRevenueDefault: '29684576',
      monthlyRevenueUnusual: false,
    });
    // 사용자가 입력한 월매출은 재무 입력에만 들어간다.
    expect(create.mock.calls[0][0].data.inputJson.monthlyRevenue).toBe('29684576');
  });

  // ADR 0011: 저장 근거는 코드에 고정하지 않고 릴리스의 해석에서 만든다.
  // 이전 해석 릴리스(SUPERSEDED)로 저장해도 근거와 값이 어긋나지 않아야 한다.
  it('스냅샷에 점수 릴리스의 매출 해석과 그 근거를 남긴다', async () => {
    for (const [interpretation, expected, basis] of [
      ['QUARTER_TOTAL', 'QUARTER_TOTAL', 'ADR 0011'],
      [undefined, 'QUARTER_MONTHLY_AVERAGE', 'ADR 0002'],
    ] as const) {
      const { prisma, create } = prismaWith({ interpretation, releaseStatus: 'SUPERSEDED' });
      mocks.getPrisma.mockReturnValue(prisma);
      expect((await createPlan(request({ title: '계획', input, marketScore: reference }))).status).toBe(201);
      const snapshot = parsePlanMarketScore(create.mock.calls[0][0].data.marketScoreJson);
      expect(snapshot?.monthlyRevenueInterpretation).toBe(expected);
      expect(snapshot?.monthlyRevenueBasis).toContain(basis);
    }
  });

  it('해석이 없는 이전 스냅샷은 ADR 0002 해석으로 읽는다', () => {
    const legacy = {
      schemaVersion: 'plan-market-score-v1',
      releaseKey: reference.releaseKey,
      modelVersion: 'market-score-v3-20262',
      marketReleaseKey: 'seoul-market-2021q1-2026q2-x',
      baseQuarter: '20262',
      areaType: 'A',
      areaCode: '3110020',
      areaName: '서울국제고등학교',
      districtCode: '11110',
      districtName: '종로구',
      industryCode: 'CS100001',
      industryName: '한식',
      score: 48,
      grade: 'B',
      monthlyRevenueDefault: '29684576',
      monthlyRevenueBasis: 'ADR 0002 잠정 해석: 최근 4분기 매출 원값 합 ÷ 같은 기간 점포 수 합(점포당 월평균)',
      monthlyRevenueUnusual: false,
      savedAt: '2026-10-31T00:00:00.000Z',
    };
    expect(parsePlanMarketScore(legacy)?.monthlyRevenueInterpretation).toBe('QUARTER_MONTHLY_AVERAGE');
  });

  it('하위·상위 1% 경계 밖의 기본값은 스냅샷에 표시한다', async () => {
    for (const monthly of ['1286587578', '79150']) {
      const { prisma, create } = prismaWith({ monthly });
      mocks.getPrisma.mockReturnValue(prisma);
      expect((await createPlan(request({ title: '계획', input, marketScore: reference }))).status).toBe(201);
      expect(create.mock.calls[0][0].data.marketScoreJson).toMatchObject({
        monthlyRevenueDefault: monthly,
        monthlyRevenueUnusual: true,
      });
    }
  });

  it('실패한 점수 릴리스나 점수를 내지 않은 상권은 409로 거부하고 저장하지 않는다', async () => {
    for (const overrides of [
      { releaseStatus: 'FAILED' },
      { releaseStatus: 'PENDING' },
      { rowStatus: 'INSUFFICIENT_STORES' },
    ]) {
      const { prisma, create } = prismaWith(overrides);
      mocks.getPrisma.mockReturnValue(prisma);
      const response = await createPlan(request({ title: '계획', input, marketScore: reference }));
      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('MARKET_SCORE_UNAVAILABLE');
      expect(create).not.toHaveBeenCalled();
    }
  });

  it('형식이 틀린 참조는 400이다', async () => {
    const { prisma } = prismaWith();
    mocks.getPrisma.mockReturnValue(prisma);
    const response = await createPlan(request({ title: '계획', input, marketScore: { ...reference, areaCode: 'x' } }));
    expect(response.status).toBe(400);
  });

  it('참조 없이 만든 계획은 스냅샷이 없다', async () => {
    const { prisma, create } = prismaWith();
    mocks.getPrisma.mockReturnValue(prisma);
    expect((await createPlan(request({ title: '계획', input }))).status).toBe(201);
    expect(prisma.marketScoreRelease.findUnique).not.toHaveBeenCalled();
    expect(parsePlanMarketScore(create.mock.calls[0][0].data.marketScoreJson)).toBeNull();
  });

  it('계획 수정은 저장된 스냅샷을 바꾸지 않는다', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      plan: { updateMany, findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'plan-a', revision: 2 }) },
    };
    mocks.getPrisma.mockReturnValue({
      plan: { findFirst: vi.fn().mockResolvedValue({ loanAssumptionJson: null }) },
      $transaction: (callback: (client: typeof tx) => unknown) => callback(tx),
    });
    const response = await updatePlan(request({ title: '계획', input, revision: 1, marketScore: reference }, 'PUT'), {
      params: Promise.resolve({ planId: 'plan-a' }),
    });
    expect(response.status).toBe(200);
    expect(updateMany.mock.calls[0][0].data).not.toHaveProperty('marketScoreJson');
  });

  it('저장된 스냅샷이 스키마와 맞지 않으면 화면에서 쓰지 않는다', () => {
    expect(parsePlanMarketScore(null)).toBeNull();
    expect(parsePlanMarketScore({ grade: 'B' })).toBeNull();
  });
});
