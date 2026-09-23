import Decimal from 'decimal.js';
import { financeInputSchema } from './schema';
import { calculateLoanSchedule } from './loan';
import { decimal, sumMoney, won } from './money';
import { scenarioAssumptions } from './scenarios';
import {
  CALCULATION_VERSION,
  INPUT_SCHEMA_VERSION,
  type CashBalanceRow,
  type FinanceInput,
  type FinanceResult,
  type FundingPosition,
  type ScenarioName,
  type ScenarioResult,
  type ValueResult,
} from './types';

const ready = <T>(value: T): ValueResult<T> => ({ status: 'READY', value });
const missing = <T>(missingFields: string[]): ValueResult<T> => ({
  status: 'INSUFFICIENT_INPUT',
  value: null,
  missingFields,
});
const unsupported = <T>(reason: string): ValueResult<T> => ({ status: 'UNSUPPORTED', value: null, reason });

function sumNullable(fields: Array<[string, string | null]>): ValueResult<string> {
  const missingFields = fields.filter(([, value]) => value === null).map(([field]) => field);
  return missingFields.length ? missing(missingFields) : ready(won(sumMoney(fields.map(([, value]) => value!))));
}

function scenarioResult(
  input: FinanceInput,
  name: ScenarioName,
  fixedCostTotal: ValueResult<string>,
  openingCash: ValueResult<string>,
  loan: ReturnType<typeof calculateLoanSchedule>,
): ScenarioResult {
  const assumptions = scenarioAssumptions(input, fixedCostTotal.status === 'READY' ? fixedCostTotal.value : null, name);
  const fixedCostMissing = fixedCostTotal.status === 'INSUFFICIENT_INPUT' ? fixedCostTotal.missingFields : [];
  const operationalMissing = [
    assumptions.monthlyRevenue === null ? 'monthlyRevenue' : null,
    ...fixedCostMissing,
    assumptions.variableCostRate === null ? 'variableCostRate' : null,
  ].filter((field): field is string => field !== null);
  const breakEvenMissing = [
    ...fixedCostMissing,
    assumptions.variableCostRate === null ? 'variableCostRate' : null,
  ].filter((field): field is string => field !== null);
  const rateUnsupported = assumptions.variableCostRate !== null && decimal(assumptions.variableCostRate).gte(1);

  const operatingBalance = operationalMissing.length
    ? missing<string>(operationalMissing)
    : rateUnsupported
      ? unsupported<string>('시나리오 적용 후 변동비율이 100% 이상입니다.')
      : ready(
          won(
            decimal(assumptions.monthlyRevenue!)
              .mul(decimal(1).minus(assumptions.variableCostRate!))
              .minus(assumptions.monthlyFixedCosts!),
          ),
        );
  const operatingBreakEven = breakEvenMissing.length
    ? missing<string>(breakEvenMissing)
    : rateUnsupported
      ? unsupported<string>('변동비율이 100% 이상이면 균형 매출을 계산할 수 없습니다.')
      : ready(won(decimal(assumptions.monthlyFixedCosts!).div(decimal(1).minus(assumptions.variableCostRate!))));

  const firstPayment =
    loan.status === 'READY'
      ? ready(loan.value.firstPayment)
      : loan.status === 'INSUFFICIENT_INPUT'
        ? missing<string>(loan.missingFields)
        : unsupported<string>(loan.reason);
  const debtBreakEvenMissing = [
    ...breakEvenMissing,
    input.existingMonthlyDebtPayment === null ? 'existingMonthlyDebtPayment' : null,
  ].filter((field): field is string => field !== null);
  const cashFlowMissing = [
    ...operationalMissing,
    input.existingMonthlyDebtPayment === null ? 'existingMonthlyDebtPayment' : null,
  ].filter((field): field is string => field !== null);
  const debtInclusiveBreakEven = debtBreakEvenMissing.length
    ? missing<string>(debtBreakEvenMissing)
    : rateUnsupported
      ? unsupported<string>('변동비율이 100% 이상이면 균형 매출을 계산할 수 없습니다.')
      : loan.status !== 'READY'
        ? loan.status === 'INSUFFICIENT_INPUT'
          ? missing<string>(loan.missingFields)
          : unsupported<string>(loan.reason)
        : ready(
            won(
              decimal(assumptions.monthlyFixedCosts!)
                .plus(input.existingMonthlyDebtPayment!)
                .plus(loan.value.firstPayment)
                .div(decimal(1).minus(assumptions.variableCostRate!)),
            ),
          );

  const firstMonthCashAfterDebtPayment: ValueResult<string> = cashFlowMissing.length
    ? missing(cashFlowMissing)
    : rateUnsupported
      ? unsupported('시나리오 적용 후 변동비율이 100% 이상입니다.')
      : loan.status !== 'READY'
        ? loan.status === 'INSUFFICIENT_INPUT'
          ? missing(loan.missingFields)
          : unsupported(loan.reason)
        : ready(
            won(
              decimal(assumptions.monthlyRevenue!)
                .mul(decimal(1).minus(assumptions.variableCostRate!))
                .minus(assumptions.monthlyFixedCosts!)
                .minus(input.existingMonthlyDebtPayment!)
                .minus(loan.value.firstPayment),
            ),
          );

  let cashBalances: ValueResult<CashBalanceRow[]>;
  if (cashFlowMissing.length) cashBalances = missing(cashFlowMissing);
  else if (rateUnsupported) cashBalances = unsupported('시나리오 적용 후 변동비율이 100% 이상입니다.');
  else if (openingCash.status !== 'READY')
    cashBalances =
      openingCash.status === 'INSUFFICIENT_INPUT'
        ? missing(openingCash.missingFields)
        : unsupported(openingCash.reason);
  else if (loan.status !== 'READY')
    cashBalances = loan.status === 'INSUFFICIENT_INPUT' ? missing(loan.missingFields) : unsupported(loan.reason);
  else {
    let balance = decimal(openingCash.value);
    const rows: CashBalanceRow[] = [];
    for (let month = 1; month <= input.cashBalanceMonths; month += 1) {
      const loanPayment = loan.value.schedule[month - 1]?.payment ?? '0';
      const cashAfterDebt = decimal(assumptions.monthlyRevenue!)
        .mul(decimal(1).minus(assumptions.variableCostRate!))
        .minus(assumptions.monthlyFixedCosts!)
        .minus(input.existingMonthlyDebtPayment!)
        .minus(loanPayment);
      balance = balance.plus(cashAfterDebt);
      rows.push({ month, loanPayment, cashAfterDebtPayment: won(cashAfterDebt), closingCashBalance: won(balance) });
    }
    cashBalances = ready(rows);
  }

  const firstNegativeCashMonth =
    cashBalances.status === 'READY'
      ? ready(cashBalances.value.find((row) => decimal(row.closingCashBalance).lt(0))?.month ?? null)
      : cashBalances.status === 'INSUFFICIENT_INPUT'
        ? missing<number | null>(cashBalances.missingFields)
        : unsupported<number | null>(cashBalances.reason);

  return {
    name,
    assumptions: {
      monthlyRevenue: assumptions.monthlyRevenue,
      monthlyFixedCosts: assumptions.monthlyFixedCosts,
      variableCostRate: assumptions.variableCostRate,
    },
    changes: assumptions.changes,
    monthlyOperatingBalance: operatingBalance,
    operatingBreakEvenRevenue: operatingBreakEven,
    debtInclusiveBreakEvenRevenue: debtInclusiveBreakEven,
    firstMonthLoanPayment: firstPayment,
    firstMonthCashAfterDebtPayment,
    cashBalances,
    firstNegativeCashMonth,
  };
}

export function calculateFinance(rawInput: FinanceInput): FinanceResult {
  const input = financeInputSchema.parse(rawInput) as FinanceInput;
  const initialExpenseTotal = sumNullable([
    ['openingExpenses.deposit', input.openingExpenses.deposit],
    ['openingExpenses.facilities', input.openingExpenses.facilities],
    ['openingExpenses.initialInventory', input.openingExpenses.initialInventory],
    ['openingExpenses.otherPreparation', input.openingExpenses.otherPreparation],
  ]);
  const fixedCostTotal = sumNullable([
    ['monthlyFixedCosts.rent', input.monthlyFixedCosts.rent],
    ['monthlyFixedCosts.labor', input.monthlyFixedCosts.labor],
    ['monthlyFixedCosts.other', input.monthlyFixedCosts.other],
  ]);
  const targetInitialFunding =
    initialExpenseTotal.status === 'READY' && input.targetReserve !== null
      ? ready(won(decimal(initialExpenseTotal.value).plus(input.targetReserve)))
      : missing<string>([
          ...(initialExpenseTotal.status === 'INSUFFICIENT_INPUT' ? initialExpenseTotal.missingFields : []),
          ...(input.targetReserve === null ? ['targetReserve'] : []),
        ]);
  const plannedFundingGap =
    targetInitialFunding.status === 'READY' && input.equity !== null
      ? ready(won(Decimal.max(0, decimal(targetInitialFunding.value).minus(input.equity))))
      : missing<string>([
          ...(targetInitialFunding.status === 'INSUFFICIENT_INPUT' ? targetInitialFunding.missingFields : []),
          ...(input.equity === null ? ['equity'] : []),
        ]);
  const principal = input.newLoan.principal ?? '0';
  const preOpeningCashAfterFunding =
    initialExpenseTotal.status === 'READY' && input.equity !== null
      ? ready(won(decimal(input.equity).plus(principal).minus(initialExpenseTotal.value)))
      : missing<string>([
          ...(initialExpenseTotal.status === 'INSUFFICIENT_INPUT' ? initialExpenseTotal.missingFields : []),
          ...(input.equity === null ? ['equity'] : []),
        ]);
  const reserveShortfall =
    preOpeningCashAfterFunding.status === 'READY' && input.targetReserve !== null
      ? ready(won(Decimal.max(0, decimal(input.targetReserve).minus(preOpeningCashAfterFunding.value))))
      : missing<string>([
          ...(preOpeningCashAfterFunding.status === 'INSUFFICIENT_INPUT'
            ? preOpeningCashAfterFunding.missingFields
            : []),
          ...(input.targetReserve === null ? ['targetReserve'] : []),
        ]);
  const fundingPosition: ValueResult<FundingPosition> =
    preOpeningCashAfterFunding.status !== 'READY' || input.targetReserve === null
      ? missing([
          ...(preOpeningCashAfterFunding.status === 'INSUFFICIENT_INPUT'
            ? preOpeningCashAfterFunding.missingFields
            : []),
          ...(input.targetReserve === null ? ['targetReserve'] : []),
        ])
      : ready(
          decimal(preOpeningCashAfterFunding.value).lt(0)
            ? 'INITIAL_EXPENSE_SHORTFALL'
            : decimal(preOpeningCashAfterFunding.value).lt(input.targetReserve)
              ? 'RESERVE_SHORTFALL'
              : 'TARGET_RESERVE_MET',
        );

  const loan = calculateLoanSchedule(input.newLoan);
  const scenarios = (['BASE', 'ADVERSE', 'IMPROVED'] as const).map((name) =>
    scenarioResult(input, name, fixedCostTotal, preOpeningCashAfterFunding, loan),
  );

  return {
    inputSchemaVersion: INPUT_SCHEMA_VERSION,
    calculationVersion: CALCULATION_VERSION,
    initialExpenseTotal,
    targetInitialFunding,
    plannedFundingGap,
    preOpeningCashAfterFunding,
    reserveShortfall,
    fundingPosition,
    loan,
    scenarios,
    excludedScope: [
      '세금',
      '재고 회전과 개업 후 재고 재구매의 상세 시점',
      '외상 매출 회수',
      '변동금리 재설정',
      '보증료',
      '일수별 이자',
      '만기일시상환',
    ],
  };
}
