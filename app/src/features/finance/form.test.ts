import { describe, expect, it } from 'vitest';
import { calculateFinance } from './calculate';
import { financeInputSchema } from './schema';
import { fromInput, newPlanInput, toInput } from './form';

// 새 계획의 재무 입력. AGENTS.md 2는 샘플 운영 데이터를 만들지 않게 하고, 3-2는 누락(null)과 실제 0을 바꾸지 않게 한다.
// 예시 금액을 입력값으로 채워 두면 사용자가 고치지 않고 [저장하고 계산]을 눌렀을 때 지어낸 숫자가 저장 결과로 남았다
// (2026-11-25 화면 점검: 아무것도 입력하지 않은 계획에 "계획상 부족자금 50,000,000원").
describe('새 계획의 재무 입력', () => {
  it('사업에 관한 값은 모두 비어 있다', () => {
    const input = newPlanInput();
    expect(input.openingExpenses).toEqual({
      deposit: null,
      facilities: null,
      initialInventory: null,
      otherPreparation: null,
    });
    expect(input.targetReserve).toBeNull();
    expect(input.equity).toBeNull();
    expect(input.monthlyRevenue).toBeNull();
    expect(input.monthlyFixedCosts).toEqual({ rent: null, labor: null, other: null });
    expect(input.variableCostRate).toBeNull();
    // 기존 상환이 없다는 것도 사용자가 정할 사실이라 0으로 채우지 않는다.
    expect(input.existingMonthlyDebtPayment).toBeNull();
    expect(input.newLoan).toEqual({
      principal: null,
      annualInterestRatePercent: null,
      totalMonths: null,
      graceMonths: null,
      repaymentMethod: null,
    });
  });

  it('현금잔액 계산기간만 12개월로 둔다', () => {
    // 사업에 관한 가정이 아니라 결과 표를 몇 달까지 보여 줄지 정하는 설정이고, 스키마가 1~120개월 값을 요구한다
    // (finance.md 계산 정책).
    expect(newPlanInput().cashBalanceMonths).toBe(12);
    expect(financeInputSchema.safeParse(newPlanInput()).success).toBe(true);
  });

  it('계산하면 지어낸 금액 대신 입력 필요를 돌려준다', () => {
    // finance.md 결과 값의 상태: 빠진 입력을 0으로 채워 계산하지 않는다.
    const result = calculateFinance(newPlanInput());
    expect(result.targetInitialFunding.status).toBe('INSUFFICIENT_INPUT');
    expect(result.plannedFundingGap.status).toBe('INSUFFICIENT_INPUT');
    expect(result.scenarios.find((scenario) => scenario.name === 'BASE')?.monthlyOperatingBalance.status).toBe(
      'INSUFFICIENT_INPUT',
    );
  });

  it('상권에서 시작한 계획은 월매출 기본값 하나만 채운다', () => {
    // ADR 0008 [이 상권으로 재무 계획 시작]: 사용자가 누른 경우 월매출만 고칠 수 있는 잠정 기본값으로 채운다.
    const input = newPlanInput({ monthlyRevenue: '18000000' });
    expect(input.monthlyRevenue).toBe('18000000');
    expect({ ...input, monthlyRevenue: null }).toEqual(newPlanInput());
  });
});

describe('입력란과 저장 입력 사이의 변환', () => {
  it('빈 칸과 0을 서로 바꾸지 않는다', () => {
    const input = { ...newPlanInput(), existingMonthlyDebtPayment: '0', equity: null };
    const form = fromInput(input);
    expect(form.existingDebt).toBe('0');
    expect(form.equity).toBe('');
    expect(toInput(form)).toEqual(input);
  });

  it('저장된 입력이 없으면 새 계획 입력란이다', () => {
    expect(toInput(fromInput(undefined))).toEqual(newPlanInput());
  });
});
