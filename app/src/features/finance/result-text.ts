// 저장된 계산 결과를 화면 문장으로 옮긴다. 계산기가 낸 값만 읽고 새 금액을 만들지 않는다.
// 빠진 값은 0으로 읽지 않고 판단하지 않는다(AGENTS.md 3-2).
import Decimal from 'decimal.js';
import type { FundingPosition, ValueResult } from './types';

// 입력 항목의 화면 이름. 결과의 missingFields와 입력 검증 오류의 경로를 이 이름으로 바꾼다.
export const FIELD_LABELS: Record<string, string> = {
  'openingExpenses.deposit': '보증금',
  'openingExpenses.facilities': '시설비',
  'openingExpenses.initialInventory': '초기 재고',
  'openingExpenses.otherPreparation': '기타 준비비',
  targetReserve: '목표 운영예비금',
  equity: '자기자금',
  monthlyRevenue: '월매출 가정',
  'monthlyFixedCosts.rent': '월 임대료',
  'monthlyFixedCosts.labor': '월 인건비',
  'monthlyFixedCosts.other': '기타 월 고정비',
  variableCostRate: '변동비율',
  existingMonthlyDebtPayment: '기존 월 상환액',
  'newLoan.principal': '신규 대출금',
  'newLoan.annualInterestRatePercent': '연 금리',
  'newLoan.totalMonths': '전체 상환개월',
  'newLoan.graceMonths': '원금 거치개월',
  'newLoan.repaymentMethod': '상환방식',
  cashBalanceMonths: '현금잔액 계산기간',
};

export const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;

// 결과 금액은 원 단위 정수 문자열이지만 finance-v1.0.0의 시나리오 금액에는 소수가 남아 있다. 소수 부분을 버리지 않는다.
export function formatWonText(value: string): string {
  const [integer, fraction] = value.split('.');
  const grouped = new Intl.NumberFormat('ko-KR').format(BigInt(integer));
  return `${fraction ? `${grouped}.${fraction}` : grouped}원`;
}

// 계산하지 못한 값은 0으로 두지 않고 이유를 적는다.
export function showValue<T>(result: ValueResult<T>, render: (value: T) => string): string {
  if (result.status === 'READY') return render(result.value);
  return result.status === 'UNSUPPORTED'
    ? `계산 불가 · ${result.reason}`
    : `입력 필요 · ${result.missingFields.map(fieldLabel).join(', ')}`;
}

// positive·caution·negative는 판단, missing은 판단하지 않은 상태다.
export type Verdict = { tone: 'positive' | 'caution' | 'negative' | 'missing'; text: string };

const FUNDING_POSITION_TEXT: Record<FundingPosition, Verdict> = {
  INITIAL_EXPENSE_SHORTFALL: { tone: 'negative', text: '자기자금과 신규 대출로 개업 비용을 다 대지 못합니다.' },
  RESERVE_SHORTFALL: { tone: 'caution', text: '개업 비용은 대지만 목표 운영예비금에는 못 미칩니다.' },
  TARGET_RESERVE_MET: { tone: 'positive', text: '개업 비용과 목표 운영예비금을 모두 채웁니다.' },
};

export function fundingPositionText(position: ValueResult<FundingPosition>): Verdict {
  if (position.status === 'READY') return FUNDING_POSITION_TEXT[position.value];
  if (position.status === 'UNSUPPORTED') return { tone: 'missing', text: `판단할 수 없습니다. ${position.reason}` };
  return { tone: 'missing', text: `판단하려면 ${position.missingFields.map(fieldLabel).join(', ')}을 넣어 주세요.` };
}

// 균형 매출은 운영수지(상환 포함이면 상환 후 잔여현금)가 0이 되는 매출이다. 같으면 감당하는 쪽으로 본다.
export function revenueVerdict(
  monthlyRevenue: string | null,
  operatingBreakEven: ValueResult<string>,
  debtInclusiveBreakEven: ValueResult<string>,
): Verdict | null {
  if (monthlyRevenue === null) return { tone: 'missing', text: '월매출 가정을 넣으면 균형 매출과 비교합니다.' };
  if (operatingBreakEven.status !== 'READY' || debtInclusiveBreakEven.status !== 'READY') return null;
  const revenue = new Decimal(monthlyRevenue);
  if (revenue.gte(debtInclusiveBreakEven.value))
    return { tone: 'positive', text: '월매출 가정이 대출 상환까지 감당하는 매출 이상입니다.' };
  if (revenue.gte(operatingBreakEven.value))
    return { tone: 'caution', text: '월매출 가정이 운영비는 감당하지만 대출 상환까지는 부족합니다.' };
  return { tone: 'negative', text: '월매출 가정이 운영비도 감당하지 못합니다.' };
}

// months는 계산한 현금잔액 표의 길이다. 그 기간 밖의 일은 말하지 않는다.
export function cashRunwayText(firstNegativeMonth: ValueResult<number | null>, months: number): Verdict | null {
  if (firstNegativeMonth.status !== 'READY') return null;
  if (firstNegativeMonth.value === null)
    return { tone: 'positive', text: `계산한 ${months}개월 동안 월말 현금이 0원 아래로 내려가지 않습니다.` };
  return { tone: 'negative', text: `${firstNegativeMonth.value}개월째 월말 현금이 0원 아래로 내려갑니다.` };
}
