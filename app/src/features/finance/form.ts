import Decimal from 'decimal.js';
import { financeInputSchema } from './schema';
import type { FinanceInput } from './types';

// 재무 입력란의 글자와 저장하는 입력(FinanceInput) 사이의 변환. 빈 칸은 null, 0은 '0'으로 서로 바꾸지 않는다(AGENTS.md 3-2).

export type FinanceForm = Record<string, string>;

// 새 계획의 입력란. 사업에 관한 값은 사용자가 넣기 전까지 비워 둔다(AGENTS.md 2·3-2). 현금잔액 계산기간은 결과 표를
// 몇 달까지 보여 줄지 정하는 설정이고 스키마가 값을 요구해서 12개월로 둔다.
const NEW_PLAN_FORM: FinanceForm = {
  deposit: '',
  facilities: '',
  initialInventory: '',
  otherPreparation: '',
  targetReserve: '',
  equity: '',
  monthlyRevenue: '',
  rent: '',
  labor: '',
  otherFixed: '',
  variableCostPercent: '',
  existingDebt: '',
  loanPrincipal: '',
  annualRatePercent: '',
  totalMonths: '',
  graceMonths: '',
  repaymentMethod: '',
  cashBalanceMonths: '12',
};

const nullable = (value: string) => (value.trim() === '' ? null : value.replaceAll(',', '').trim());
const integerOrNull = (value: string) => (value.trim() === '' ? null : Number(value));
const percentToRatio = (value: string) => {
  if (!value.trim()) return null;
  try {
    return new Decimal(value).div(100).toString();
  } catch {
    return value;
  }
};

export function toInput(form: FinanceForm): FinanceInput {
  return {
    openingExpenses: {
      deposit: nullable(form.deposit),
      facilities: nullable(form.facilities),
      initialInventory: nullable(form.initialInventory),
      otherPreparation: nullable(form.otherPreparation),
    },
    targetReserve: nullable(form.targetReserve),
    equity: nullable(form.equity),
    monthlyRevenue: nullable(form.monthlyRevenue),
    monthlyFixedCosts: { rent: nullable(form.rent), labor: nullable(form.labor), other: nullable(form.otherFixed) },
    variableCostRate: percentToRatio(form.variableCostPercent),
    existingMonthlyDebtPayment: nullable(form.existingDebt),
    newLoan: {
      principal: nullable(form.loanPrincipal),
      annualInterestRatePercent: nullable(form.annualRatePercent),
      totalMonths: integerOrNull(form.totalMonths),
      graceMonths: integerOrNull(form.graceMonths),
      repaymentMethod: form.repaymentMethod
        ? (form.repaymentMethod as FinanceInput['newLoan']['repaymentMethod'])
        : null,
    },
    cashBalanceMonths: Number(form.cashBalanceMonths),
  };
}

// 새 계획의 입력. 상권에서 넘어온 월매출 기본값처럼 사용자가 고칠 수 있는 값만 overrides로 채운다(ADR 0008).
export function newPlanInput(overrides: Readonly<Record<string, string>> = {}): FinanceInput {
  return toInput({ ...NEW_PLAN_FORM, ...overrides });
}

export function fromInput(input?: FinanceInput): FinanceForm {
  if (!input) return NEW_PLAN_FORM;
  return {
    deposit: input.openingExpenses.deposit ?? '',
    facilities: input.openingExpenses.facilities ?? '',
    initialInventory: input.openingExpenses.initialInventory ?? '',
    otherPreparation: input.openingExpenses.otherPreparation ?? '',
    targetReserve: input.targetReserve ?? '',
    equity: input.equity ?? '',
    monthlyRevenue: input.monthlyRevenue ?? '',
    rent: input.monthlyFixedCosts.rent ?? '',
    labor: input.monthlyFixedCosts.labor ?? '',
    otherFixed: input.monthlyFixedCosts.other ?? '',
    variableCostPercent: input.variableCostRate === null ? '' : new Decimal(input.variableCostRate).mul(100).toString(),
    existingDebt: input.existingMonthlyDebtPayment ?? '',
    loanPrincipal: input.newLoan.principal ?? '',
    annualRatePercent: input.newLoan.annualInterestRatePercent ?? '',
    totalMonths: input.newLoan.totalMonths?.toString() ?? '',
    graceMonths: input.newLoan.graceMonths?.toString() ?? '',
    repaymentMethod: input.newLoan.repaymentMethod ?? '',
    cashBalanceMonths: input.cashBalanceMonths.toString(),
  };
}

// 결과를 계산한 입력(결과의 inputSnapshot)과 지금 입력란이 같은지. 계획은 제목·사업 조건·자금 조건만 저장해도 저장 번호가
// 오르므로 저장 번호로는 결과가 지금 입력의 것인지 알 수 없다. 둘 다 같은 스키마로 읽어 같은 모양으로 견준다.
// 스냅샷을 읽지 못하면 null을 돌려줘, 부르는 쪽이 다른 방법으로 판단하게 한다.
export function sameAsCalculatedInput(form: FinanceForm, snapshot: unknown): boolean | null {
  const calculated = financeInputSchema.safeParse(snapshot);
  if (!calculated.success) return null;
  const current = financeInputSchema.safeParse(toInput(form));
  if (!current.success) return false;
  return JSON.stringify(current.data) === JSON.stringify(calculated.data);
}
