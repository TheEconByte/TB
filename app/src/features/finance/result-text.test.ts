import { describe, expect, it } from 'vitest';
import { calculateFinance } from './calculate';
import { newPlanInput } from './form';
import { cashRunwayText, formatWonText, fundingPositionText, revenueVerdict } from './result-text';
import type { FinanceInput, ValueResult } from './types';

const ready = <T>(value: T): ValueResult<T> => ({ status: 'READY', value });
const missing = <T>(fields: string[]): ValueResult<T> => ({
  status: 'INSUFFICIENT_INPUT',
  value: null,
  missingFields: fields,
});

// 결과 맨 위의 판단 문장은 계산기가 이미 낸 값만 옮긴다. 새 숫자를 만들거나 빠진 값을 0으로 읽지 않는다(AGENTS.md 3-2).
describe('개업 자금 상태 문장', () => {
  it('계산기의 세 자금 상태를 서로 다른 문장으로 옮긴다', () => {
    // 기준: docs/domains/finance.md "자금 상태" — 개업 직전 현금 < 0, < 목표 예비금, 그 외.
    expect(fundingPositionText(ready('INITIAL_EXPENSE_SHORTFALL'))).toEqual({
      tone: 'negative',
      text: '자기자금과 신규 대출로 개업 비용을 다 대지 못합니다.',
    });
    expect(fundingPositionText(ready('RESERVE_SHORTFALL'))).toEqual({
      tone: 'caution',
      text: '개업 비용은 대지만 목표 운영예비금에는 못 미칩니다.',
    });
    expect(fundingPositionText(ready('TARGET_RESERVE_MET'))).toEqual({
      tone: 'positive',
      text: '개업 비용과 목표 운영예비금을 모두 채웁니다.',
    });
  });

  it('입력이 빠졌으면 판단하지 않고 빠진 항목을 적는다', () => {
    expect(fundingPositionText(missing(['equity', 'targetReserve']))).toEqual({
      tone: 'missing',
      text: '판단하려면 자기자금, 목표 운영예비금을 넣어 주세요.',
    });
  });
});

describe('월매출 가정과 균형 매출 비교', () => {
  it('상환 포함 균형 매출 이상이면 상환까지 감당한다고 쓴다', () => {
    // 균형 매출은 운영수지(또는 상환 후 잔여현금)가 0이 되는 매출이므로 같으면 감당하는 쪽이다.
    expect(revenueVerdict('12000000', ready('10000000'), ready('12000000'))).toEqual({
      tone: 'positive',
      text: '월매출 가정이 대출 상환까지 감당하는 매출 이상입니다.',
    });
  });

  it('운영비 충당 매출과 상환 포함 균형 매출 사이면 상환이 부족하다고 쓴다', () => {
    expect(revenueVerdict('11000000', ready('10000000'), ready('12000000'))).toEqual({
      tone: 'caution',
      text: '월매출 가정이 운영비는 감당하지만 대출 상환까지는 부족합니다.',
    });
  });

  it('운영비 충당 매출보다 낮으면 운영비도 감당하지 못한다고 쓴다', () => {
    expect(revenueVerdict('9000000', ready('10000000'), ready('12000000'))).toEqual({
      tone: 'negative',
      text: '월매출 가정이 운영비도 감당하지 못합니다.',
    });
  });

  it('월매출 가정이 비었으면 비교하지 않았다고 쓴다', () => {
    expect(revenueVerdict(null, ready('10000000'), ready('12000000'))).toEqual({
      tone: 'missing',
      text: '월매출 가정을 넣으면 균형 매출과 비교합니다.',
    });
  });

  it('균형 매출을 계산하지 못했으면 문장을 내지 않는다', () => {
    // 이유는 아래 표의 각 칸이 적는다(showValue).
    expect(
      revenueVerdict('9000000', missing(['monthlyFixedCosts.rent']), missing(['monthlyFixedCosts.rent'])),
    ).toBeNull();
  });

  it('finance-v1.0.0의 소수 금액도 decimal로 비교한다', () => {
    // docs/domains/finance.md 시나리오: v1.0.0은 시나리오 금액을 반올림하지 않아 소수 문자열이 남아 있다.
    expect(revenueVerdict('10000000.5', ready('10000000.4'), ready('12000000'))?.tone).toBe('caution');
  });
});

describe('현금 바닥 문장', () => {
  it('처음 0원 아래로 내려가는 달을 쓴다', () => {
    expect(cashRunwayText(ready(4), 12)).toEqual({
      tone: 'negative',
      text: '4개월째 월말 현금이 0원 아래로 내려갑니다.',
    });
  });

  it('내려가지 않으면 계산한 기간을 함께 쓴다', () => {
    // 계산한 기간 밖의 일은 말하지 않는다.
    expect(cashRunwayText(ready(null), 12)).toEqual({
      tone: 'positive',
      text: '계산한 12개월 동안 월말 현금이 0원 아래로 내려가지 않습니다.',
    });
  });

  it('계산하지 못했으면 문장을 내지 않는다', () => {
    expect(cashRunwayText(missing(['equity']), 0)).toBeNull();
  });
});

describe('원 표시', () => {
  it('정수는 천 단위로 끊고 소수 금액은 소수 부분을 버리지 않는다', () => {
    expect(formatWonText('12345678')).toBe('12,345,678원');
    expect(formatWonText('-5000')).toBe('-5,000원');
    expect(formatWonText('10000000.5')).toBe('10,000,000.5원');
  });
});

describe('실제 계산 결과와 이어 붙이기', () => {
  it('계산기 결과를 그대로 받아 문장을 만든다', () => {
    const input: FinanceInput = {
      ...newPlanInput(),
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
    };
    const result = calculateFinance(input);
    const base = result.scenarios[0];
    // 개업 직전 현금 = 4천만 + 5천만 − 8천만 = 1천만 = 목표 예비금이므로 채운다.
    expect(fundingPositionText(result.fundingPosition).tone).toBe('positive');
    expect(
      revenueVerdict(
        base.assumptions.monthlyRevenue,
        base.operatingBreakEvenRevenue,
        base.debtInclusiveBreakEvenRevenue,
      )?.tone,
    ).toBe('positive');
  });
});
