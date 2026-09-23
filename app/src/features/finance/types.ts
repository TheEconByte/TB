export const CALCULATION_VERSION = 'finance-v1.0.0';
export const INPUT_SCHEMA_VERSION = 'finance-input-v1.0.0';

export type ResultStatus = 'READY' | 'INSUFFICIENT_INPUT' | 'UNSUPPORTED';
export type RepaymentMethod = 'EQUAL_PAYMENT' | 'EQUAL_PRINCIPAL';

export type FinanceInput = {
  openingExpenses: {
    deposit: string | null;
    facilities: string | null;
    initialInventory: string | null;
    otherPreparation: string | null;
  };
  targetReserve: string | null;
  equity: string | null;
  monthlyRevenue: string | null;
  monthlyFixedCosts: {
    rent: string | null;
    labor: string | null;
    other: string | null;
  };
  variableCostRate: string | null;
  existingMonthlyDebtPayment: string | null;
  newLoan: {
    principal: string | null;
    annualInterestRatePercent: string | null;
    totalMonths: number | null;
    graceMonths: number | null;
    repaymentMethod: RepaymentMethod | null;
  };
  cashBalanceMonths: number;
};

export type ValueResult<T> =
  | { status: 'READY'; value: T }
  | { status: 'INSUFFICIENT_INPUT'; value: null; missingFields: string[] }
  | { status: 'UNSUPPORTED'; value: null; reason: string };

export type LoanScheduleRow = {
  month: number;
  phase: 'GRACE' | 'REPAYMENT';
  principal: string;
  interest: string;
  payment: string;
  remainingPrincipal: string;
};

export type LoanSummary = {
  schedule: LoanScheduleRow[];
  firstPayment: string;
  firstPaymentAfterGrace: string;
  maximumPayment: string;
  totalPrincipal: string;
  totalInterest: string;
};

export type FundingPosition = 'INITIAL_EXPENSE_SHORTFALL' | 'RESERVE_SHORTFALL' | 'TARGET_RESERVE_MET';

export type ScenarioName = 'BASE' | 'ADVERSE' | 'IMPROVED';

export type ScenarioChange = {
  field: 'monthlyRevenue' | 'monthlyFixedCosts' | 'variableCostRate';
  kind: 'PERCENT' | 'PERCENTAGE_POINT';
  amount: string;
  description: string;
};

export type CashBalanceRow = {
  month: number;
  loanPayment: string;
  cashAfterDebtPayment: string;
  closingCashBalance: string;
};

export type ScenarioResult = {
  name: ScenarioName;
  assumptions: {
    monthlyRevenue: string | null;
    monthlyFixedCosts: string | null;
    variableCostRate: string | null;
  };
  changes: ScenarioChange[];
  monthlyOperatingBalance: ValueResult<string>;
  operatingBreakEvenRevenue: ValueResult<string>;
  debtInclusiveBreakEvenRevenue: ValueResult<string>;
  firstMonthLoanPayment: ValueResult<string>;
  firstMonthCashAfterDebtPayment: ValueResult<string>;
  cashBalances: ValueResult<CashBalanceRow[]>;
  firstNegativeCashMonth: ValueResult<number | null>;
};

export type FinanceResult = {
  inputSchemaVersion: string;
  calculationVersion: string;
  initialExpenseTotal: ValueResult<string>;
  targetInitialFunding: ValueResult<string>;
  plannedFundingGap: ValueResult<string>;
  preOpeningCashAfterFunding: ValueResult<string>;
  reserveShortfall: ValueResult<string>;
  fundingPosition: ValueResult<FundingPosition>;
  loan: ValueResult<LoanSummary>;
  scenarios: ScenarioResult[];
  excludedScope: string[];
};
