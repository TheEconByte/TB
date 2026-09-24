import Decimal from 'decimal.js';
import { decimal, won } from './money';
import type { FinanceInput, ScenarioChange, ScenarioName } from './types';

export const SCENARIO_TEMPLATES: Record<Exclude<ScenarioName, 'BASE'>, ScenarioChange[]> = {
  ADVERSE: [
    { field: 'monthlyRevenue', kind: 'PERCENT', amount: '-20', description: '월매출 20% 감소' },
    { field: 'monthlyFixedCosts', kind: 'PERCENT', amount: '5', description: '월 고정비 5% 증가' },
    { field: 'variableCostRate', kind: 'PERCENTAGE_POINT', amount: '5', description: '변동비율 5%p 증가' },
  ],
  IMPROVED: [
    { field: 'monthlyRevenue', kind: 'PERCENT', amount: '10', description: '월매출 10% 증가' },
    { field: 'monthlyFixedCosts', kind: 'PERCENT', amount: '-5', description: '월 고정비 5% 감소' },
    { field: 'variableCostRate', kind: 'PERCENTAGE_POINT', amount: '-2', description: '변동비율 2%p 감소(최저 0%)' },
  ],
};

// 시나리오 금액 가정은 원 단위로 반올림한 뒤 파생 값을 계산한다. 결과에 담긴 가정으로
// 운영수지·균형 매출을 그대로 다시 계산할 수 있어야 한다.
const changePercent = (value: string | null, percent: string) =>
  value === null ? null : won(decimal(value).mul(decimal(1).plus(decimal(percent).div(100))));
const changePoint = (value: string | null, points: string) =>
  value === null ? null : Decimal.max(0, decimal(value).plus(decimal(points).div(100))).toString();

export function scenarioAssumptions(input: FinanceInput, fixedCostTotal: string | null, name: ScenarioName) {
  if (name === 'BASE') {
    return {
      monthlyRevenue: input.monthlyRevenue,
      monthlyFixedCosts: fixedCostTotal,
      variableCostRate: input.variableCostRate,
      changes: [] as ScenarioChange[],
    };
  }
  const changes = SCENARIO_TEMPLATES[name];
  const revenueChange = changes.find((change) => change.field === 'monthlyRevenue')!;
  const fixedChange = changes.find((change) => change.field === 'monthlyFixedCosts')!;
  const variableChange = changes.find((change) => change.field === 'variableCostRate')!;
  return {
    monthlyRevenue: changePercent(input.monthlyRevenue, revenueChange.amount),
    monthlyFixedCosts: changePercent(fixedCostTotal, fixedChange.amount),
    variableCostRate: changePoint(input.variableCostRate, variableChange.amount),
    changes,
  };
}
