import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '../../generated/prisma/client.ts';

const mocks = vi.hoisted(() => ({ currentUser: vi.fn(), getPrisma: vi.fn() }));
vi.mock('@/lib/session', () => ({ currentUser: mocks.currentUser }));
vi.mock('@/lib/prisma', () => ({ getPrisma: mocks.getPrisma }));

import { POST as createPlan } from '@/app/api/plans/route';
import { GET as getPlan, PUT as updatePlan } from '@/app/api/plans/[planId]/route';
import { POST as calculatePlan } from '@/app/api/plans/[planId]/calculations/route';
import { GET as getResult } from '@/app/api/plans/[planId]/results/[resultId]/route';
import { financeInputSchema } from '@/features/finance/schema.ts';
import type { FinanceInput } from '@/features/finance/types';
import {
  describeLoanAssumption,
  planLoanAssumptionSchema,
  retainedLoanAssumption,
  type PlanLoanAssumption,
} from '@/features/plans/loan-assumption.ts';

// 대출 가정 적용 기능은 ADR 0009 §5로 없앴다. 이 파일은 그 뒤에도 지켜야 하는 것을 검사한다.
// - 이미 저장된 plans.loanAssumptionJson·plan_results.loanAssumptionJson은 그대로 읽고 표시한다.
// - 새로 쓰지 않는다. 계획 수정은 기존 출처를 유지하거나 지우기만 하고, 계산은 계획의 출처를 결과로 옮기기만 한다.
// - 과거 plan_results는 다시 계산하지 않는다(AGENTS.md §3의 7번).

const APPLIED_AT = '2026-09-21T00:00:00.000Z';

// F1 검산 예제와 같은 개업 전 자금·운영 가정.
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

// 없앤 POST /api/plans/{id}/loan-assumption이 저장하던 모양 그대로의 스냅샷(ADR 0009 Validation의 호환성 fixture).
const STORED_ASSUMPTION: PlanLoanAssumption = {
  productKey: 'test-loan',
  version: '1.0.0',
  name: '테스트 대출 상품',
  catalogKey: 'test-catalog',
  catalogVersion: '2026-09-20.1',
  appliedAt: APPLIED_AT,
  newLoan: {
    principal: '10000000',
    annualInterestRatePercent: '3',
    totalMonths: 60,
    graceMonths: 0,
    repaymentMethod: 'EQUAL_PAYMENT',
  },
};

const context = { params: Promise.resolve({ planId: 'plan-a' }) };
const planContext = (planId: string) => ({ params: Promise.resolve({ planId }) });
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

describe('저장된 대출 가정 읽기', () => {
  it('없앤 적용 기능이 저장한 스냅샷을 그대로 읽고 어느 상품 조건인지와 승인 확정이 아님을 보여 준다', () => {
    const parsed = planLoanAssumptionSchema.parse(STORED_ASSUMPTION);
    expect(parsed).toEqual(STORED_ASSUMPTION);

    const text = describeLoanAssumption(parsed);
    expect(text).toContain('test-loan@1.0.0');
    expect(text).toContain('test-catalog@2026-09-20.1');
    expect(text).toContain('원금 10,000,000원');
    expect(text).toContain('연 3%');
    expect(text).toContain('60개월');
    expect(text).toContain('승인 확정이 아니며');
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
});

describe('상품 조건을 계획에 옮기는 경로가 없다(ADR 0009 §5)', () => {
  // 대출 가정 출처를 새로 만드는 API가 다시 생기면 이 검사가 실패한다. 출처를 다루는 곳은 계획 수정(유지하거나 지움)과
  // 계산(계획의 출처를 결과로 옮김)뿐이어야 한다. 읽기만 하는 API는 행 전체를 돌려주므로 이 이름을 쓰지 않는다.
  it('loanAssumptionJson을 다루는 API는 계획 수정과 계산뿐이다', () => {
    const apiRoot = fileURLToPath(new URL('../../app/api', import.meta.url));
    const routes: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name === 'route.ts' && readFileSync(path, 'utf8').includes('loanAssumptionJson')) {
          routes.push(relative(apiRoot, path).replaceAll('\\', '/'));
        }
      }
    };
    walk(apiRoot);
    expect(routes.sort()).toEqual(['plans/[planId]/calculations/route.ts', 'plans/[planId]/route.ts']);
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

  it('저장된 상품 출처가 없으면 계획 수정이 출처를 만들지 않는다', async () => {
    const updateMany = stubUpdate(null);
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

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL에서 저장된 대출 가정과 결과 불변성', () => {
  let client: PrismaClient | null = null;
  const USER_ID = 'test-loan-assumption-user';

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
  });

  afterAll(async () => {
    await db().plan.deleteMany({ where: { userId: USER_ID } });
    await db().user.deleteMany({ where: { id: USER_ID } });
    await db().$disconnect();
  });

  beforeEach(() => {
    mocks.currentUser.mockResolvedValue({ id: USER_ID, email: 'test-loan-assumption@example.com' });
    mocks.getPrisma.mockReturnValue(db());
  });

  // 적용 기능이 있던 때 저장된 계획: 신규 대출 입력이 상품 확정 조건과 같고 출처가 함께 저장돼 있다.
  async function planWithStoredAssumption(): Promise<{ id: string; revision: number }> {
    const response = await createPlan(
      jsonRequest({ title: '대출 가정 계획', input: { ...input, newLoan: STORED_ASSUMPTION.newLoan } }),
    );
    expect(response.status).toBe(201);
    const created = (await response.json()).plan as { id: string; revision: number };
    await db().plan.update({
      where: { id: created.id },
      data: { loanAssumptionJson: STORED_ASSUMPTION as Prisma.InputJsonValue },
    });
    return created;
  }

  it('저장된 출처를 계획·결과에서 그대로 읽고, 직접 수정하면 계획의 출처만 지우며 과거 결과는 그대로다', async () => {
    const created = await planWithStoredAssumption();
    const planContextFor = planContext(created.id);

    const detail = await getPlan(new Request('http://localhost'), planContextFor);
    expect((await detail.json()).plan.loanAssumptionJson).toEqual(STORED_ASSUMPTION);

    const calculated = await calculatePlan(new Request('http://localhost', { method: 'POST' }), planContextFor);
    expect(calculated.status).toBe(201);
    const calculatedPayload = await calculated.json();
    expect(calculatedPayload.result.loanAssumptionJson).toEqual(STORED_ASSUMPTION);
    const resultDetail = await getResult(new Request('http://localhost'), {
      params: Promise.resolve({ planId: created.id, resultId: calculatedPayload.result.id }),
    });
    expect((await resultDetail.json()).result.loanAssumptionJson).toEqual(STORED_ASSUMPTION);

    // 제목만 고치면 신규 대출 입력이 그대로라 출처도 그대로다.
    const titleOnly = await updatePlan(
      jsonRequest(
        { title: '제목만 수정', input: { ...input, newLoan: STORED_ASSUMPTION.newLoan }, revision: created.revision },
        'PUT',
      ),
      planContextFor,
    );
    expect(titleOnly.status).toBe(200);
    const kept = await db().plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(kept.loanAssumptionJson).toEqual(STORED_ASSUMPTION);

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
        { title: '대출 가정 계획', input: { ...input, newLoan: manualLoan }, revision: kept.revision },
        'PUT',
      ),
      planContextFor,
    );
    expect(manual.status).toBe(200);
    const afterPlan = await db().plan.findUniqueOrThrow({ where: { id: created.id } });
    expect(afterPlan.revision).toBe(kept.revision + 1);
    expect(financeInputSchema.parse(afterPlan.inputJson).newLoan).toEqual(manualLoan);
    expect(afterPlan.loanAssumptionJson).toBeNull();

    // 상품 조건이 반영된 과거 결과는 다시 계산하지 않고 그대로 남는다.
    const after = await db().planResult.findUniqueOrThrow({ where: { id: calculatedPayload.result.id } });
    expect(after.resultJson).toEqual(before.resultJson);
    expect(after.loanAssumptionJson).toEqual(STORED_ASSUMPTION);
    expect(after.inputSnapshot).toEqual(before.inputSnapshot);

    // 출처가 지워진 뒤의 계산 결과에는 출처가 없다.
    const recalculated = await calculatePlan(new Request('http://localhost', { method: 'POST' }), planContextFor);
    expect((await recalculated.json()).result.loanAssumptionJson).toBeNull();
  });
});
