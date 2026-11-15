import Decimal from 'decimal.js';

// 서울시 추정매출 원값(당월_매출_금액)을 점포당 월매출로 보는 해석. 점수 계산·화면·계획 스냅샷이 모두 여기를 따른다.
// - QUARTER_TOTAL(ADR 0011): 원값은 분기 합계이므로 3으로 나눈다. 지금 만드는 점수 릴리스의 해석이다.
// - QUARTER_MONTHLY_AVERAGE(ADR 0002): 원값을 분기 월평균으로 보고 그대로 썼다.
//   해석이 기록되지 않은 이전 점수 릴리스와 계획 스냅샷은 이 해석으로 만들어졌다.

export const MONTHLY_REVENUE_INTERPRETATIONS = ['QUARTER_TOTAL', 'QUARTER_MONTHLY_AVERAGE'] as const;
export type MonthlyRevenueInterpretation = (typeof MONTHLY_REVENUE_INTERPRETATIONS)[number];

export const CURRENT_MONTHLY_REVENUE_INTERPRETATION: MonthlyRevenueInterpretation = 'QUARTER_TOTAL';

// 원값 하나가 덮는 달 수
const SALES_VALUE_MONTHS: Record<MonthlyRevenueInterpretation, number> = {
  QUARTER_TOTAL: 3,
  QUARTER_MONTHLY_AVERAGE: 1,
};

const PHRASES: Record<MonthlyRevenueInterpretation, string> = {
  QUARTER_TOTAL: '분기 합계로 보고 3으로 나눈',
  QUARTER_MONTHLY_AVERAGE: '분기 월평균으로 본',
};

const BASES: Record<MonthlyRevenueInterpretation, string> = {
  QUARTER_TOTAL: 'ADR 0011 잠정 해석: 최근 4분기 매출 원값 합 ÷ (같은 기간 점포 수 합 × 3)(점포당 월평균)',
  QUARTER_MONTHLY_AVERAGE: 'ADR 0002 잠정 해석: 최근 4분기 매출 원값 합 ÷ 같은 기간 점포 수 합(점포당 월평균)',
};

// 매출 원값 합 ÷ (점포 수 합 × 원값 하나가 덮는 달 수). 반올림하지 않으므로 표시·저장할 때 한 번만 반올림한다.
export function monthlyRevenuePerStore(
  salesSum: Decimal.Value,
  storeCountSum: number,
  interpretation: MonthlyRevenueInterpretation = CURRENT_MONTHLY_REVENUE_INTERPRETATION,
): Decimal {
  return new Decimal(salesSum).div(new Decimal(storeCountSum).times(SALES_VALUE_MONTHS[interpretation]));
}

// 점수 릴리스 요약이나 계획 스냅샷에 기록된 해석. 기록이 없으면 ADR 0002 해석이고, 모르는 값은 거부한다.
export function recordedInterpretation(value: unknown): MonthlyRevenueInterpretation {
  if (value === undefined || value === null) return 'QUARTER_MONTHLY_AVERAGE';
  if ((MONTHLY_REVENUE_INTERPRETATIONS as readonly unknown[]).includes(value)) {
    return value as MonthlyRevenueInterpretation;
  }
  throw new Error(`알 수 없는 월매출 해석입니다: ${String(value)}`);
}

// "매출 원값을 ___ 잠정 해석" 문장에 들어가는 말
export function interpretationPhrase(interpretation: MonthlyRevenueInterpretation): string {
  return PHRASES[interpretation];
}

// 계획 스냅샷에 남기는 계산 근거
export function interpretationBasis(interpretation: MonthlyRevenueInterpretation): string {
  return BASES[interpretation];
}

// 계산식 끝에 붙이는 나눗셈. 이전 해석은 붙이지 않는다.
export function interpretationDivisor(interpretation: MonthlyRevenueInterpretation): string {
  const months = SALES_VALUE_MONTHS[interpretation];
  return months === 1 ? '' : ` ÷ ${months}`;
}
