import { z } from 'zod';
import type { FinanceInput } from '../finance/types.ts';
import { MAX_ANNUAL_INTEREST_RATE_PERCENT, MAX_LOAN_TERM_MONTHS, MAX_MONEY_WON_DIGITS } from '../finance/limits.ts';
import { assessProductRepayment, type ProductLoanTerms } from '../funding/eligibility.ts';
import type { FundingProduct } from '../funding/schema.ts';

// 계획에 저장한 대출 가정의 출처. 어느 상품 버전의 확정 조건을 썼는지(상품 키·버전·
// 카탈로그 버전)와 적용 시각을 보존하고, 계산 시점의 계획에서 결과로 복사해 어떤
// 상품 조건이 반영됐는지 추적할 수 있게 한다. 사용자가 직접 입력한 값과 구분한다.
export const planLoanAssumptionSchema = z.strictObject({
  productKey: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  catalogKey: z.string().min(1),
  catalogVersion: z.string().min(1),
  appliedAt: z.string().min(1),
  newLoan: z.strictObject({
    principal: z
      .string()
      .max(MAX_MONEY_WON_DIGITS)
      .regex(/^(0|[1-9]\d*)$/, '원 단위 정수 문자열이어야 합니다.'),
    annualInterestRatePercent: z
      .string()
      .max(20)
      .regex(/^\d+(\.\d+)?$/, '0 이상의 숫자여야 합니다.')
      .refine((value) => Number(value) <= MAX_ANNUAL_INTEREST_RATE_PERCENT),
    totalMonths: z.number().int().positive().max(MAX_LOAN_TERM_MONTHS),
    graceMonths: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_LOAN_TERM_MONTHS - 1),
    repaymentMethod: z.enum(['EQUAL_PAYMENT', 'EQUAL_PRINCIPAL']),
  }),
});

export type PlanLoanAssumption = z.infer<typeof planLoanAssumptionSchema>;
export type LoanAssumptionNewLoan = PlanLoanAssumption['newLoan'];

export function loanAssumptionKey(value: { productKey: string; version: string }): string {
  return `${value.productKey}@${value.version}`;
}

// 화면에서 상품 확정 조건을 적용한 가정임을 밝히는 문장. 어떤 상품 버전·카탈로그를
// 썼는지와 승인 확정이 아님을 함께 표시한다.
export function describeLoanAssumption(value: PlanLoanAssumption): string {
  const method = value.newLoan.repaymentMethod === 'EQUAL_PAYMENT' ? '원리금균등' : '원금균등';
  const principal = new Intl.NumberFormat('ko-KR').format(BigInt(value.newLoan.principal));
  return `상품 ${value.productKey}@${value.version} 확정 조건(카탈로그 ${value.catalogKey}@${value.catalogVersion})을 적용한 가정입니다. 원금 ${principal}원 · 연 ${value.newLoan.annualInterestRatePercent}% · ${value.newLoan.totalMonths}개월(원금 거치 ${value.newLoan.graceMonths}개월) · ${method}. 승인 확정이 아니며 실제 승인·적용 조건은 심사로 결정됩니다. 값을 직접 고치면 이 출처는 저장 시 지워집니다.`;
}

// 확정 조건이 있는 대출 상품만 신규 대출 가정으로 바꾼다. 지원금·보증·공간·프로그램과
// 금리·기간·상환방식이 확정되지 않은 상품은 null이며, 호출자는 0원 상환으로 대신하지
// 않고 판정 사유를 표시한다. 계산은 F1 엔진이 하고 여기서는 입력 값만 정한다.
export function loanAssumptionFromProduct(
  product: FundingProduct,
  catalog: { catalogKey: string; catalogVersion: string },
  appliedAt: string,
  principalKrw: string,
): PlanLoanAssumption | null {
  const { supported, publicLimitKrw, terms } = assessProductRepayment(product);
  if (!supported || publicLimitKrw === null || terms === null) return null;
  if (!/^[1-9]\d*$/.test(principalKrw) || BigInt(principalKrw) > BigInt(publicLimitKrw)) return null;
  const mapped: ProductLoanTerms = terms;
  return {
    productKey: product.productKey,
    version: product.version,
    name: product.name,
    catalogKey: catalog.catalogKey,
    catalogVersion: catalog.catalogVersion,
    appliedAt,
    newLoan: {
      principal: principalKrw,
      annualInterestRatePercent: mapped.annualInterestRatePercent,
      totalMonths: mapped.totalMonths,
      graceMonths: mapped.graceMonths,
      repaymentMethod: mapped.repaymentMethod === 'EQUAL_INSTALLMENT' ? 'EQUAL_PAYMENT' : 'EQUAL_PRINCIPAL',
    },
  };
}

function sameNewLoan(left: LoanAssumptionNewLoan, right: FinanceInput['newLoan']): boolean {
  return (
    left.principal === right.principal &&
    left.annualInterestRatePercent === right.annualInterestRatePercent &&
    left.totalMonths === right.totalMonths &&
    left.graceMonths === right.graceMonths &&
    left.repaymentMethod === right.repaymentMethod
  );
}

// 저장된 상품 가정과 새로 저장하는 신규 대출 입력이 값까지 같을 때만 출처를 유지한다.
// 사용자가 직접 값을 바꾸면 상품 조건이 아닌 값을 상품 조건으로 표시하지 않도록 지운다.
export function retainedLoanAssumption(stored: unknown, nextLoan: FinanceInput['newLoan']): PlanLoanAssumption | null {
  const parsed = planLoanAssumptionSchema.safeParse(stored);
  if (!parsed.success) return null;
  return sameNewLoan(parsed.data.newLoan, nextLoan) ? parsed.data : null;
}
