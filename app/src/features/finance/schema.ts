import { z } from 'zod';
import { MAX_ANNUAL_INTEREST_RATE_PERCENT, MAX_LOAN_TERM_MONTHS, MAX_MONEY_WON_DIGITS } from './limits';

const wonString = z
  .string()
  .max(MAX_MONEY_WON_DIGITS, `금액은 ${MAX_MONEY_WON_DIGITS}자리 이하여야 합니다.`)
  .regex(/^(0|[1-9]\d*)$/, '0 이상의 원 단위 정수로 입력해 주세요.')
  .nullable();

const nonNegativeDecimalString = z
  .string()
  .max(20, '숫자가 너무 깁니다.')
  .regex(/^\d+(\.\d+)?$/, '0 이상의 숫자로 입력해 주세요.')
  .refine((value) => !value.startsWith('-'), '음수는 입력할 수 없습니다.')
  .nullable();

const rateString = nonNegativeDecimalString.refine(
  (value) => value === null || Number(value) < 1,
  '변동비율은 0 이상 1 미만이어야 합니다.',
);

const annualInterestRateString = nonNegativeDecimalString.refine(
  (value) => value === null || Number(value) <= MAX_ANNUAL_INTEREST_RATE_PERCENT,
  `연 금리는 ${MAX_ANNUAL_INTEREST_RATE_PERCENT}% 이하여야 합니다.`,
);

export const financeInputSchema = z
  .object({
    openingExpenses: z.object({
      deposit: wonString,
      facilities: wonString,
      initialInventory: wonString,
      otherPreparation: wonString,
    }),
    targetReserve: wonString,
    equity: wonString,
    monthlyRevenue: wonString,
    monthlyFixedCosts: z.object({
      rent: wonString,
      labor: wonString,
      other: wonString,
    }),
    variableCostRate: rateString,
    existingMonthlyDebtPayment: wonString,
    newLoan: z.object({
      principal: wonString,
      annualInterestRatePercent: annualInterestRateString,
      totalMonths: z
        .number()
        .int('전체 상환개월은 정수여야 합니다.')
        .positive('전체 상환개월은 1 이상이어야 합니다.')
        .max(MAX_LOAN_TERM_MONTHS, `전체 상환개월은 ${MAX_LOAN_TERM_MONTHS}개월 이하여야 합니다.`)
        .nullable(),
      graceMonths: z
        .number()
        .int('거치개월은 정수여야 합니다.')
        .nonnegative('거치개월은 0 이상이어야 합니다.')
        .max(MAX_LOAN_TERM_MONTHS - 1, `거치개월은 ${MAX_LOAN_TERM_MONTHS - 1}개월 이하여야 합니다.`)
        .nullable(),
      repaymentMethod: z.enum(['EQUAL_PAYMENT', 'EQUAL_PRINCIPAL']).nullable(),
    }),
    cashBalanceMonths: z
      .number()
      .int('현금잔액 기간은 정수여야 합니다.')
      .positive('현금잔액 기간은 1개월 이상이어야 합니다.')
      .max(120, '현금잔액 기간은 120개월 이하여야 합니다.'),
  })
  .superRefine((input, context) => {
    const { principal, totalMonths, graceMonths } = input.newLoan;
    if (
      principal !== null &&
      principal !== '0' &&
      totalMonths !== null &&
      graceMonths !== null &&
      graceMonths >= totalMonths
    ) {
      context.addIssue({
        code: 'custom',
        path: ['newLoan', 'graceMonths'],
        message: '거치개월은 전체 상환개월보다 작아야 합니다.',
      });
    }
  });

export type ParsedFinanceInput = z.infer<typeof financeInputSchema>;
