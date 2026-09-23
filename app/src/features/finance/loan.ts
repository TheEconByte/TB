import Decimal from 'decimal.js';
import { decimal, roundWon, won } from './money';
import type { FinanceInput, LoanScheduleRow, LoanSummary, ValueResult } from './types';

const missing = <T>(missingFields: string[]): ValueResult<T> => ({
  status: 'INSUFFICIENT_INPUT',
  value: null,
  missingFields,
});

export function calculateLoanSchedule(input: FinanceInput['newLoan']): ValueResult<LoanSummary> {
  if (input.principal === null || input.principal === '0') {
    return {
      status: 'READY',
      value: {
        schedule: [],
        firstPayment: '0',
        firstPaymentAfterGrace: '0',
        maximumPayment: '0',
        totalPrincipal: '0',
        totalInterest: '0',
      },
    };
  }

  const missingFields = [
    input.annualInterestRatePercent === null ? 'newLoan.annualInterestRatePercent' : null,
    input.totalMonths === null ? 'newLoan.totalMonths' : null,
    input.graceMonths === null ? 'newLoan.graceMonths' : null,
    input.repaymentMethod === null ? 'newLoan.repaymentMethod' : null,
  ].filter((field): field is string => field !== null);
  if (missingFields.length) return missing(missingFields);

  const principal = roundWon(decimal(input.principal));
  const totalMonths = input.totalMonths!;
  const graceMonths = input.graceMonths!;
  if (graceMonths >= totalMonths)
    return { status: 'UNSUPPORTED', value: null, reason: '거치개월은 전체 상환개월보다 작아야 합니다.' };

  const repaymentMonths = totalMonths - graceMonths;
  const monthlyRate = decimal(input.annualInterestRatePercent!).div(100).div(12);
  let remaining = principal;
  const schedule: LoanScheduleRow[] = [];
  const repaymentAmount = monthlyRate.isZero()
    ? principal.div(repaymentMonths)
    : principal.mul(monthlyRate).div(decimal(1).minus(decimal(1).plus(monthlyRate).pow(-repaymentMonths)));
  const equalPrincipalAmount = principal.div(repaymentMonths);

  for (let month = 1; month <= totalMonths; month += 1) {
    const interest = roundWon(remaining.mul(monthlyRate));
    const inGrace = month <= graceMonths;
    let principalPayment = decimal(0);
    if (!inGrace) {
      const finalMonth = month === totalMonths;
      if (finalMonth) {
        principalPayment = remaining;
      } else if (input.repaymentMethod === 'EQUAL_PRINCIPAL') {
        principalPayment = Decimal.min(roundWon(equalPrincipalAmount), remaining);
      } else {
        principalPayment = Decimal.min(Decimal.max(roundWon(repaymentAmount.minus(interest)), 0), remaining);
      }
    }
    const payment = principalPayment.plus(interest);
    remaining = remaining.minus(principalPayment);
    schedule.push({
      month,
      phase: inGrace ? 'GRACE' : 'REPAYMENT',
      principal: won(principalPayment),
      interest: won(interest),
      payment: won(payment),
      remainingPrincipal: won(remaining),
    });
  }

  const totalPrincipal = schedule.reduce((sum, row) => sum.plus(row.principal), decimal(0));
  const totalInterest = schedule.reduce((sum, row) => sum.plus(row.interest), decimal(0));
  const maximumPayment = schedule.reduce((max, row) => Decimal.max(max, row.payment), decimal(0));
  const afterGrace = schedule[graceMonths] ?? schedule[0];

  return {
    status: 'READY',
    value: {
      schedule,
      firstPayment: schedule[0]?.payment ?? '0',
      firstPaymentAfterGrace: afterGrace?.payment ?? '0',
      maximumPayment: won(maximumPayment),
      totalPrincipal: won(totalPrincipal),
      totalInterest: won(totalInterest),
    },
  };
}
