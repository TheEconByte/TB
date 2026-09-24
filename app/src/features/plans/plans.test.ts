import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinanceInput } from '@/features/finance/types';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getPrisma: vi.fn() }));
vi.mock('@/lib/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }));

import { GET as listPlans, POST as createPlan } from '@/app/api/plans/route';
import { GET as getPlan, PUT as updatePlan, DELETE as deletePlan } from '@/app/api/plans/[planId]/route';
import { POST as calculatePlan } from '@/app/api/plans/[planId]/calculations/route';
import { GET as listResults } from '@/app/api/plans/[planId]/results/route';
import { GET as getResult } from '@/app/api/plans/[planId]/results/[resultId]/route';

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
const context = { params: Promise.resolve({ planId: 'plan-a' }) };
const jsonRequest = (body: unknown) =>
  new Request('http://localhost/api/plans', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.currentUser.mockResolvedValue({ id: 'user-a', email: 'a@example.com' });
});

describe('인증 경계', () => {
  it('미로그인 사용자의 생성·목록·상세·수정·삭제·계산·결과 조회를 모두 401로 차단한다', async () => {
    mocks.currentUser.mockResolvedValue(null);
    const responses = await Promise.all([
      createPlan(jsonRequest({ title: 'A', input })),
      listPlans(),
      getPlan(new Request('http://localhost'), context),
      updatePlan(jsonRequest({ title: 'A', input, revision: 1 }), context),
      deletePlan(new Request('http://localhost'), context),
      calculatePlan(new Request('http://localhost', { method: 'POST' }), context),
      listResults(new Request('http://localhost'), context),
      getResult(new Request('http://localhost'), {
        params: Promise.resolve({ planId: 'plan-a', resultId: 'result-a' }),
      }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });
});

describe('소유권과 revision', () => {
  it('목록 쿼리를 현재 사용자 ID로 제한한다', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    mocks.getPrisma.mockReturnValue({ plan: { findMany } });
    expect((await listPlans()).status).toBe(200);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'user-a' } }));
  });
  it('다른 사용자의 plan과 result는 404로 숨긴다', async () => {
    mocks.getPrisma.mockReturnValue({
      plan: { findFirst: vi.fn().mockResolvedValue(null), deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
      planResult: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    expect((await getPlan(new Request('http://localhost'), context)).status).toBe(404);
    expect((await deletePlan(new Request('http://localhost'), context)).status).toBe(404);
    expect((await calculatePlan(new Request('http://localhost', { method: 'POST' }), context)).status).toBe(404);
    expect(
      (
        await getResult(new Request('http://localhost'), {
          params: Promise.resolve({ planId: 'plan-a', resultId: 'result-a' }),
        })
      ).status,
    ).toBe(404);
  });
  it('현재 revision은 1 증가시키고 오래된 revision은 409이며 데이터를 덮어쓰지 않는다', async () => {
    const updateMany = vi.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    const tx = {
      plan: {
        updateMany,
        findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'plan-a', revision: 2 }),
        findFirst: vi.fn().mockResolvedValue({ revision: 2 }),
      },
    };
    mocks.getPrisma.mockReturnValue({
      plan: { findFirst: vi.fn().mockResolvedValue({ loanAssumptionJson: null }) },
      $transaction: (callback: (value: typeof tx) => unknown) => callback(tx),
    });
    const request = () => jsonRequest({ title: 'A', input, revision: 1 });
    const success = await updatePlan(request(), context);
    const conflict = await updatePlan(request(), context);
    expect(success.status).toBe(200);
    expect(conflict.status).toBe(409);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'plan-a', userId: 'user-a', revision: 1 },
        data: expect.objectContaining({ revision: { increment: 1 } }),
      }),
    );
    expect(tx.plan.findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });
});

describe('서버 계산과 불변 결과', () => {
  it('클라이언트 결과를 무시하고 저장된 입력의 문자열과 null 스냅샷을 저장한다', async () => {
    let created: Record<string, unknown> | undefined;
    const storedInput = structuredClone(input);
    const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      created = structuredClone(data);
      return { id: 'result-a', ...data };
    });
    mocks.getPrisma.mockReturnValue({
      plan: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'plan-a',
          userId: 'user-a',
          revision: 1,
          inputSchemaVersion: 'finance-input-v1.0.0',
          inputJson: storedInput,
        }),
      },
      planResult: { findUnique: vi.fn().mockResolvedValue(null), create },
    });
    const response = await calculatePlan(jsonRequest({ resultJson: { plannedFundingGap: '조작값' } }), context);
    expect(response.status).toBe(201);
    expect(created?.inputSnapshot).toEqual(storedInput);
    expect((created?.inputSnapshot as FinanceInput).openingExpenses.initialInventory).toBeNull();
    expect((created?.resultJson as { plannedFundingGap: { status: string } }).plannedFundingGap.status).toBe(
      'INSUFFICIENT_INPUT',
    );
    expect(JSON.stringify(created?.resultJson)).not.toContain('조작값');
  });
  it('동일 plan·revision·계산 버전이면 기존 결과를 재사용한다', async () => {
    const existing = { id: 'result-existing', inputRevision: 1 };
    const create = vi.fn();
    mocks.getPrisma.mockReturnValue({
      plan: {
        findFirst: vi.fn().mockResolvedValue({
          id: 'plan-a',
          userId: 'user-a',
          revision: 1,
          inputSchemaVersion: 'finance-input-v1.0.0',
          inputJson: input,
        }),
      },
      planResult: { findUnique: vi.fn().mockResolvedValue(existing), create },
    });
    const response = await calculatePlan(new Request('http://localhost', { method: 'POST' }), context);
    expect(response.status).toBe(200);
    expect(create).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ result: existing, reused: true });
  });
});

describe('요청 빈도 제한', () => {
  // 한도는 사용자별 프로세스 메모리 버킷이라, 다른 테스트와 섞이지 않게 사용자마다 따로 쓴다.
  const repeat = async (count: number, call: () => Promise<Response>) => {
    const statuses: number[] = [];
    for (let index = 0; index < count; index += 1) statuses.push((await call()).status);
    return statuses;
  };

  it('계획 목록·상세 조회에는 제한을 두지 않는다', async () => {
    mocks.currentUser.mockResolvedValue({ id: 'rate-reader', email: 'r@example.com' });
    mocks.getPrisma.mockReturnValue({
      plan: {
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue({ id: 'plan-a', results: [] }),
      },
    });
    expect(new Set(await repeat(70, () => listPlans()))).toEqual(new Set([200]));
    expect(new Set(await repeat(70, () => getPlan(new Request('http://localhost'), context)))).toEqual(new Set([200]));
  });

  it('생성은 분당 30회, 수정은 60회, 삭제는 30회를 넘으면 429와 Retry-After를 준다', async () => {
    mocks.getPrisma.mockReturnValue({ plan: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) } });
    // 잘못된 본문은 한도 확인 뒤 400이 되므로, DB 없이 한도만 소모한다.
    mocks.currentUser.mockResolvedValue({ id: 'rate-creator', email: 'c@example.com' });
    expect(await repeat(30, () => createPlan(jsonRequest({})))).toEqual(Array(30).fill(400));
    const createDenied = await createPlan(jsonRequest({}));
    expect(createDenied.status).toBe(429);
    expect(Number(createDenied.headers.get('Retry-After'))).toBeGreaterThan(0);

    mocks.currentUser.mockResolvedValue({ id: 'rate-updater', email: 'u@example.com' });
    const updated = await repeat(61, () => updatePlan(jsonRequest({}), context));
    expect(updated.slice(0, 60)).toEqual(Array(60).fill(400));
    expect(updated[60]).toBe(429);

    mocks.currentUser.mockResolvedValue({ id: 'rate-deleter', email: 'd@example.com' });
    const deleted = await repeat(31, () => deletePlan(new Request('http://localhost'), context));
    expect(deleted.slice(0, 30)).toEqual(Array(30).fill(404));
    expect(deleted[30]).toBe(429);
  });
});

describe('사업 조건 입력 검증', () => {
  it('형식이 틀린 면적은 500이 아니라 400이고 DB에 닿지 않는다', async () => {
    const businessProfile = {
      districtCode: '11200',
      marketIndustryCode: 'CS100010',
      detailedIndustryCode: null,
      area: { value: 'abc', unit: 'PYEONG' },
      floor: 'GROUND_1',
      buildingType: 'SMALL_RETAIL',
    };
    const response = await createPlan(jsonRequest({ title: 'A', input, businessProfile }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_INPUT');
    expect(mocks.getPrisma).not.toHaveBeenCalled();
  });
});
