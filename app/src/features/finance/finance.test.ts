import { describe, expect, it } from 'vitest';
import { calculateFinance } from './calculate';
import { calculateLoanSchedule } from './loan';
import { financeInputSchema } from './schema';
import type { FinanceInput, FinanceResult, ValueResult } from './types';

const exampleInput = (overrides: Partial<FinanceInput> = {}): FinanceInput => ({
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
    principal: '50000000',
    annualInterestRatePercent: '5',
    totalMonths: 60,
    graceMonths: 0,
    repaymentMethod: 'EQUAL_PAYMENT',
  },
  cashBalanceMonths: 12,
  ...overrides,
});

// 결과에서 금액인 값만 모은다. 변동비율·상태·설명 같은 금액이 아닌 문자열은 뺀다.
function moneyValues(result: FinanceResult): string[] {
  const ready = (value: ValueResult<string>) => (value.status === 'READY' ? [value.value] : []);
  const loan = result.loan.status === 'READY' ? result.loan.value : null;
  return [
    ...[
      result.initialExpenseTotal,
      result.targetInitialFunding,
      result.plannedFundingGap,
      result.preOpeningCashAfterFunding,
      result.reserveShortfall,
    ].flatMap(ready),
    ...(loan
      ? [
          loan.firstPayment,
          loan.firstPaymentAfterGrace,
          loan.maximumPayment,
          loan.totalPrincipal,
          loan.totalInterest,
          ...loan.schedule.flatMap((row) => [row.principal, row.interest, row.payment, row.remainingPrincipal]),
        ]
      : []),
    ...result.scenarios.flatMap((scenario) => [
      ...[scenario.assumptions.monthlyRevenue, scenario.assumptions.monthlyFixedCosts].filter(
        (value): value is string => value !== null,
      ),
      ...[
        scenario.monthlyOperatingBalance,
        scenario.operatingBreakEvenRevenue,
        scenario.debtInclusiveBreakEvenRevenue,
        scenario.firstMonthLoanPayment,
        scenario.firstMonthCashAfterDebtPayment,
      ].flatMap(ready),
      ...(scenario.cashBalances.status === 'READY'
        ? scenario.cashBalances.value.flatMap((row) => [
            row.loanPayment,
            row.cashAfterDebtPayment,
            row.closingCashBalance,
          ])
        : []),
    ]),
  ];
}

describe('입력 스키마', () => {
  it.each([
    ['변동비 100%', { variableCostRate: '1' }],
    ['변동비 100% 초과', { variableCostRate: '1.01' }],
    ['음수 비용', { openingExpenses: { ...exampleInput().openingExpenses, deposit: '-1' } }],
    ['상환기간 0', { newLoan: { ...exampleInput().newLoan, totalMonths: 0 } }],
    ['상환기간 600개월 초과', { newLoan: { ...exampleInput().newLoan, totalMonths: 601 } }],
    ['연이율 100% 초과', { newLoan: { ...exampleInput().newLoan, annualInterestRatePercent: '100.01' } }],
    ['원 단위 18자리 초과', { equity: '1000000000000000000' }],
    ['거치기간이 전체기간 이상', { newLoan: { ...exampleInput().newLoan, graceMonths: 60 } }],
  ])('%s를 거부한다', (_, override) => {
    expect(financeInputSchema.safeParse(exampleInput(override as Partial<FinanceInput>)).success).toBe(false);
  });
  it('변동비율 0을 허용한다', () =>
    expect(financeInputSchema.safeParse(exampleInput({ variableCostRate: '0' })).success).toBe(true));
});

describe('자금과 운영 계산', () => {
  it('설계 8.5 예제를 정확한 원 단위로 계산한다', () => {
    const result = calculateFinance(exampleInput());
    const [base, adverse] = result.scenarios;
    expect(result.targetInitialFunding).toMatchObject({ status: 'READY', value: '90000000' });
    expect(result.plannedFundingGap).toMatchObject({ status: 'READY', value: '50000000' });
    expect(result.preOpeningCashAfterFunding).toMatchObject({ status: 'READY', value: '10000000' });
    expect(base.operatingBreakEvenRevenue).toMatchObject({ status: 'READY', value: '10769231' });
    expect(base.debtInclusiveBreakEvenRevenue).toMatchObject({ status: 'READY', value: '12220865' });
    expect(base.firstMonthLoanPayment).toMatchObject({ status: 'READY', value: '943562' });
    expect(base.firstMonthCashAfterDebtPayment).toMatchObject({ status: 'READY', value: '5056438' });
    expect(adverse.firstMonthCashAfterDebtPayment).toMatchObject({ status: 'READY', value: '1306438' });
  });
  it('null과 0을 구분하고 매출 누락에도 초기 결과를 제공한다', () => {
    const missingRevenue = calculateFinance(exampleInput({ monthlyRevenue: null }));
    expect(missingRevenue.plannedFundingGap.status).toBe('READY');
    expect(missingRevenue.scenarios[0].monthlyOperatingBalance).toMatchObject({
      status: 'INSUFFICIENT_INPUT',
      missingFields: ['monthlyRevenue'],
    });
    expect(missingRevenue.scenarios[0].operatingBreakEvenRevenue).toMatchObject({ status: 'READY', value: '10769231' });
    expect(missingRevenue.scenarios[0].debtInclusiveBreakEvenRevenue).toMatchObject({
      status: 'READY',
      value: '12220865',
    });
    expect(calculateFinance(exampleInput({ monthlyRevenue: '0' })).scenarios[0].monthlyOperatingBalance).toMatchObject({
      status: 'READY',
      value: '-7000000',
    });
  });
  it('초기비용 누락과 월 현금흐름 계산 가능 여부를 분리한다', () => {
    const input = exampleInput({ openingExpenses: { ...exampleInput().openingExpenses, initialInventory: null } });
    const result = calculateFinance(input);
    expect(result.scenarios[0].firstMonthCashAfterDebtPayment).toMatchObject({ status: 'READY', value: '5056438' });
    expect(result.scenarios[0].cashBalances).toMatchObject({
      status: 'INSUFFICIENT_INPUT',
      missingFields: ['openingExpenses.initialInventory'],
    });
  });
  it('누락된 초기 지출을 0으로 바꾸지 않는다', () => {
    const input = exampleInput({ openingExpenses: { ...exampleInput().openingExpenses, initialInventory: null } });
    expect(calculateFinance(input).initialExpenseTotal).toMatchObject({
      status: 'INSUFFICIENT_INPUT',
      missingFields: ['openingExpenses.initialInventory'],
    });
  });
  it('초기 지출 미충족과 목표 예비금 미충족을 구분한다', () => {
    expect(
      calculateFinance(exampleInput({ newLoan: { ...exampleInput().newLoan, principal: '20000000' } })).fundingPosition,
    ).toMatchObject({ value: 'INITIAL_EXPENSE_SHORTFALL' });
    expect(
      calculateFinance(exampleInput({ newLoan: { ...exampleInput().newLoan, principal: '45000000' } })).fundingPosition,
    ).toMatchObject({ value: 'RESERVE_SHORTFALL' });
    expect(calculateFinance(exampleInput()).fundingPosition).toMatchObject({ value: 'TARGET_RESERVE_MET' });
  });
  it('큰 금액을 number 정밀도 손실 없이 계산한다', () => {
    const result = calculateFinance(
      exampleInput({
        openingExpenses: { deposit: '9007199254740993', facilities: '1', initialInventory: '0', otherPreparation: '0' },
        targetReserve: '1',
        equity: '0',
        newLoan: {
          principal: '0',
          annualInterestRatePercent: null,
          totalMonths: null,
          graceMonths: null,
          repaymentMethod: null,
        },
      }),
    );
    expect(result.targetInitialFunding).toMatchObject({ value: '9007199254740995' });
  });
});

describe('대출 일정', () => {
  it('5천만원 연 5% 60개월 원리금균등을 검산하고 마지막 잔액을 보정한다', () => {
    const loan = calculateLoanSchedule(exampleInput().newLoan);
    expect(loan.status).toBe('READY');
    if (loan.status !== 'READY') return;
    expect(loan.value.firstPayment).toBe('943562');
    expect(loan.value.totalPrincipal).toBe('50000000');
    expect(loan.value.schedule.at(-1)?.remainingPrincipal).toBe('0');
  });
  it('0% 금리와 원금균등의 원금 합계 및 최종 잔액을 맞춘다', () => {
    const loan = calculateLoanSchedule({
      principal: '100',
      annualInterestRatePercent: '0',
      totalMonths: 3,
      graceMonths: 0,
      repaymentMethod: 'EQUAL_PRINCIPAL',
    });
    expect(loan.status).toBe('READY');
    if (loan.status !== 'READY') return;
    expect(loan.value.schedule.map((row) => row.principal)).toEqual(['33', '33', '34']);
    expect(loan.value.totalPrincipal).toBe('100');
    expect(loan.value.totalInterest).toBe('0');
    expect(loan.value.schedule.at(-1)?.remainingPrincipal).toBe('0');
  });
  it('0원 및 null 대출을 정상 무차입으로 계산한다', () => {
    for (const principal of ['0', null])
      expect(
        calculateLoanSchedule({
          principal,
          annualInterestRatePercent: null,
          totalMonths: null,
          graceMonths: null,
          repaymentMethod: null,
        }),
      ).toMatchObject({ status: 'READY', value: { firstPayment: '0', totalPrincipal: '0', schedule: [] } });
  });
  it('거치 중 이자만 내고 종료 직후 원금을 상환한다', () => {
    const loan = calculateLoanSchedule({
      principal: '12000000',
      annualInterestRatePercent: '12',
      totalMonths: 14,
      graceMonths: 2,
      repaymentMethod: 'EQUAL_PAYMENT',
    });
    expect(loan.status).toBe('READY');
    if (loan.status !== 'READY') return;
    expect(loan.value.schedule[0]).toMatchObject({ principal: '0', interest: '120000', payment: '120000' });
    expect(Number(loan.value.firstPaymentAfterGrace)).toBeGreaterThan(120000);
    expect(loan.value.totalPrincipal).toBe('12000000');
  });
  it('원 단위 반올림 후 행 합계와 요약 합계가 일치한다', () => {
    const loan = calculateLoanSchedule({
      principal: '10000001',
      annualInterestRatePercent: '4.7',
      totalMonths: 37,
      graceMonths: 5,
      repaymentMethod: 'EQUAL_PAYMENT',
    });
    expect(loan.status).toBe('READY');
    if (loan.status !== 'READY') return;
    expect(loan.value.schedule.reduce((sum, row) => sum + BigInt(row.principal), 0n).toString()).toBe(
      loan.value.totalPrincipal,
    );
    expect(loan.value.schedule.reduce((sum, row) => sum + BigInt(row.interest), 0n).toString()).toBe(
      loan.value.totalInterest,
    );
  });
});

describe('시나리오', () => {
  it('퍼센트와 퍼센트포인트 변경을 구분하고 대출 조건은 유지한다', () => {
    const result = calculateFinance(exampleInput());
    const adverse = result.scenarios[1];
    const improved = result.scenarios[2];
    expect(adverse.assumptions).toEqual({
      monthlyRevenue: '16000000',
      monthlyFixedCosts: '7350000',
      variableCostRate: '0.4',
    });
    expect(improved.assumptions).toEqual({
      monthlyRevenue: '22000000',
      monthlyFixedCosts: '6650000',
      variableCostRate: '0.33',
    });
    expect(adverse.changes.map((change) => change.kind)).toEqual(['PERCENT', 'PERCENT', 'PERCENTAGE_POINT']);
    expect(result.loan.status === 'READY' && result.loan.value.firstPayment).toBe('943562');
  });
  it('시나리오 금액 가정을 원 단위로 반올림하고 그 값으로 운영수지를 계산한다', () => {
    const result = calculateFinance(
      exampleInput({ monthlyRevenue: '1000001', monthlyFixedCosts: { rent: '1234567', labor: '0', other: '0' } }),
    );
    const [, adverse, improved] = result.scenarios;
    // 1,000,001 × 0.8 = 800,000.8, 1,234,567 × 1.05 = 1,296,295.35
    expect(adverse.assumptions).toMatchObject({ monthlyRevenue: '800001', monthlyFixedCosts: '1296295' });
    expect(improved.assumptions).toMatchObject({ monthlyRevenue: '1100001', monthlyFixedCosts: '1172839' });
    // 800,001 × (1 − 0.4) − 1,296,295 = −816,294.4
    expect(adverse.monthlyOperatingBalance).toMatchObject({ status: 'READY', value: '-816294' });
  });
  it('결과의 모든 금액이 원 단위 정수 문자열이다', () => {
    const result = calculateFinance(
      exampleInput({
        openingExpenses: {
          deposit: '30000001',
          facilities: '40000003',
          initialInventory: '5000007',
          otherPreparation: '9',
        },
        targetReserve: '10000011',
        equity: '40000013',
        monthlyRevenue: '20000017',
        monthlyFixedCosts: { rent: '3000019', labor: '3000023', other: '1000029' },
        variableCostRate: '0.355',
        existingMonthlyDebtPayment: '12345',
        newLoan: {
          principal: '50000031',
          annualInterestRatePercent: '4.7',
          totalMonths: 37,
          graceMonths: 5,
          repaymentMethod: 'EQUAL_PAYMENT',
        },
      }),
    );
    const money = moneyValues(result);
    expect(money.length).toBeGreaterThan(100);
    for (const value of money) expect(value).toMatch(/^-?(0|[1-9]\d*)$/);
  });
});
