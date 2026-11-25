import { describe, expect, it } from 'vitest';
import { calculateFinance } from './calculate';
import { financeInputSchema } from './schema';
import { fromInput, newPlanInput, sameAsCalculatedInput, toInput } from './form';

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

// 보고 있는 결과가 지금 입력으로 계산한 것인지. 계획은 제목·사업 조건·자금 조건만 저장해도 저장 번호가 오르므로,
// 저장 번호가 아니라 결과에 남은 입력 스냅샷과 지금 재무 입력을 견준다(2026-11-26 화면 점검: 자금 공고 조건만
// 저장했는데 "입력이 바뀌어 결과가 이전 값입니다"가 떴다).
describe('결과를 계산한 입력과 지금 입력 비교', () => {
  const snapshot = (form = fromInput(newPlanInput({ monthlyRevenue: '20000000' }))) =>
    financeInputSchema.parse(toInput(form));

  it('재무 입력이 같으면 같다', () => {
    const form = fromInput(newPlanInput({ monthlyRevenue: '20000000' }));
    expect(sameAsCalculatedInput(form, snapshot())).toBe(true);
  });

  it('재무 입력 하나라도 바뀌면 다르다', () => {
    const form = { ...fromInput(newPlanInput({ monthlyRevenue: '20000000' })), monthlyRevenue: '21000000' };
    expect(sameAsCalculatedInput(form, snapshot())).toBe(false);
  });

  it('비운 칸과 0은 다른 입력이다', () => {
    // AGENTS.md 3-2: 누락 null과 실제 0을 바꾸지 않는다.
    const form = { ...fromInput(newPlanInput({ monthlyRevenue: '20000000' })), existingDebt: '0' };
    expect(sameAsCalculatedInput(form, snapshot())).toBe(false);
  });

  it('지금 입력이 형식에 맞지 않으면 다르다', () => {
    const form = { ...fromInput(newPlanInput({ monthlyRevenue: '20000000' })), totalMonths: '열두' };
    expect(sameAsCalculatedInput(form, snapshot())).toBe(false);
  });

  it('스냅샷을 읽지 못하면 판단하지 않는다', () => {
    // 호출하는 쪽이 저장 번호 비교로 돌아가게 null을 돌려준다.
    expect(sameAsCalculatedInput(fromInput(undefined), undefined)).toBeNull();
    expect(sameAsCalculatedInput(fromInput(undefined), { monthlyRevenue: 'x' })).toBeNull();
  });
});
