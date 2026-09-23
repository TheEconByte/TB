import { z } from 'zod';
import { MAX_ANNUAL_INTEREST_RATE_PERCENT, MAX_LOAN_TERM_MONTHS, MAX_MONEY_WON_DIGITS } from '../finance/limits.ts';
import {
  BUSINESS_STAGES,
  EVIDENCE_SUBJECTS,
  FUNDING_CATALOG_SCHEMA_VERSION,
  INDUSTRY_SCOPES,
  OBSERVED_APPLICATION_STATUSES,
  PURPOSES,
  REGION_SCOPES,
  REPAYMENT_METHODS,
  RETRIEVAL_METHODS,
  SUPPORT_TYPES,
  isOfficialUrl,
  isRealDate,
} from './types.ts';

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 형식이어야 합니다.')
  .refine(isRealDate, '존재하지 않는 날짜입니다.');

// 원 단위 정수 문자열. 큰 금액의 정밀도를 잃지 않도록 숫자로 변환하지 않는다.
const wonString = z
  .string()
  .max(MAX_MONEY_WON_DIGITS, `금액은 ${MAX_MONEY_WON_DIGITS}자리 이하여야 합니다.`)
  .regex(/^(0|[1-9]\d*)$/, '원 단위 정수 문자열이어야 합니다.');
// 금리·비율 같은 소수 문자열. 확정된 값이 없으면 null이며 0으로 대신 채우지 않는다.
const decimalString = z
  .string()
  .max(20, '숫자가 너무 깁니다.')
  .regex(/^\d+(\.\d+)?$/, '0 이상의 숫자여야 합니다.')
  .refine(
    (value) => Number(value) <= MAX_ANNUAL_INTEREST_RATE_PERCENT,
    `연 금리는 ${MAX_ANNUAL_INTEREST_RATE_PERCENT}% 이하여야 합니다.`,
  );
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 16진수 64자여야 합니다.');
const officialUrl = z
  .string()
  .refine(
    isOfficialUrl,
    '공식 기관(HTTPS) 원문 주소여야 합니다. 검색 요약·블로그·언론 기사 주소는 사용할 수 없습니다.',
  );

const productKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{2,63}$/, '소문자·숫자·하이픈으로 된 3~64자 키여야 합니다.');

const productVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'MAJOR.MINOR.PATCH 형식이어야 합니다.');

const regionSchema = z.object({
  scope: z.enum(REGION_SCOPES),
  districtCodes: z.array(z.string().regex(/^\d{5}$/, '자치구 코드는 숫자 5자리여야 합니다.')).default([]),
  note: z.string().trim().min(1).nullable(),
});

const purposeSchema = z.object({
  included: z.array(z.enum(PURPOSES)).default([]),
  excluded: z.array(z.enum(PURPOSES)).default([]),
  note: z.string().trim().min(1).nullable(),
});

const industryConditionSchema = z.object({
  scope: z.enum(INDUSTRY_SCOPES),
  included: z.array(z.string().regex(/^[A-Z]{2}\d{6}$/, '업종 코드는 CS100001 형식이어야 합니다.')).default([]),
  excluded: z.array(z.string().regex(/^[A-Z]{2}\d{6}$/, '업종 코드는 CS100001 형식이어야 합니다.')).default([]),
  note: z.string().trim().min(1).nullable(),
});

const applicationPeriodSchema = z.object({
  start: isoDate.nullable(),
  end: isoDate.nullable(),
  note: z.string().trim().min(1).nullable(),
});

const evidenceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, '근거 id는 소문자·숫자·하이픈이어야 합니다.'),
  subject: z.enum(EVIDENCE_SUBJECTS),
  summary: z.string().trim().min(5, '근거 요약을 입력해 주세요.'),
  sourceUrl: officialUrl,
  sourceDocumentName: z.string().trim().min(2),
  observedAt: isoDate,
  retrievalMethod: z.enum(RETRIEVAL_METHODS),
  checksum: sha256Hex.nullable(),
});

export const fundingProductSchema = z.object({
  productKey: productKeySchema,
  version: productVersionSchema,
  name: z.string().trim().min(2).max(200),
  organization: z.string().trim().min(2).max(200),
  supportType: z.enum(SUPPORT_TYPES),
  eligibleBusinessStages: z.array(z.enum(BUSINESS_STAGES)).min(1, '신청 가능한 사업단계를 하나 이상 기록해 주세요.'),
  region: regionSchema,
  purpose: purposeSchema,
  industryConditions: industryConditionSchema,
  applicationPeriod: applicationPeriodSchema,
  observedApplicationStatus: z.enum(OBSERVED_APPLICATION_STATUSES),
  observedAt: isoDate,
  reviewedAt: isoDate.nullable(),
  nextReviewAt: isoDate.nullable(),
  officialUrl,
  sourceDocumentName: z.string().trim().min(2),
  // 원본 파일을 내려받아 보관하지 않았으면 checksum은 null이어야 한다.
  sourceDocumentRetrieved: z.boolean(),
  sourceChecksum: sha256Hex.nullable(),
  publicLimit: wonString.nullable(),
  interestCondition: z.string().trim().min(1).nullable(),
  // 금리가 원문에 확정 숫자로 있는 경우에만 true다. 범위·변동금리는 false다.
  interestRateConfirmed: z.boolean(),
  // 확정된 고정 연 금리(%). interestRateConfirmed가 true일 때만 값이 있다. 범위·변동
  // 금리는 확정 숫자가 아니므로 null로 남기고 상환 계산 대상으로 삼지 않는다.
  interestRatePercent: decimalString.nullable().default(null),
  repaymentCondition: z.string().trim().min(1).nullable(),
  repaymentMethod: z.enum(REPAYMENT_METHODS),
  // 상환 계산에 쓰는 구조화된 확정 조건. 원문에서 확인하지 못한 값은 0이 아니라 null이다.
  repaymentTermMonths: z
    .number()
    .int('전체 상환개월은 정수여야 합니다.')
    .positive('전체 상환개월은 1 이상이어야 합니다.')
    .max(MAX_LOAN_TERM_MONTHS, `전체 상환개월은 ${MAX_LOAN_TERM_MONTHS}개월 이하여야 합니다.`)
    .nullable()
    .default(null),
  repaymentGraceMonths: z
    .number()
    .int('거치개월은 정수여야 합니다.')
    .nonnegative('거치개월은 0 이상이어야 합니다.')
    .max(MAX_LOAN_TERM_MONTHS - 1, `거치개월은 ${MAX_LOAN_TERM_MONTHS - 1}개월 이하여야 합니다.`)
    .nullable()
    .default(null),
  // 비어 있으면 상품 조건 기반 상환 계산을 제공할 수 있다고 본다. 대출이 아닌
  // 유형이거나 금리·기간·상환방식이 불명확하면 반드시 사유를 남긴다.
  unsupportedCalculationReasons: z.array(z.string().trim().min(1)).default([]),
  additionalChecks: z.array(z.string().trim().min(1)).default([]),
  reviewer: z.string().trim().min(1),
  evidence: z.array(evidenceSchema).min(1, '상품마다 공식 원문 근거를 하나 이상 기록해 주세요.'),
});

export const fundingCatalogSchema = z.object({
  catalogKey: productKeySchema,
  schemaVersion: z.literal(FUNDING_CATALOG_SCHEMA_VERSION),
  catalogVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/, 'YYYY-MM-DD.N 형식이어야 합니다.'),
  // 이 카탈로그를 판정한 기준일. 검수 기한·날짜 모순은 이 날짜로 계산한다.
  basisDate: isoDate,
  reviewer: z.string().trim().min(1),
  notes: z.array(z.string().trim().min(1)).default([]),
  products: z.array(fundingProductSchema).min(1, '상품을 하나 이상 기록해 주세요.'),
});

export type FundingProduct = z.infer<typeof fundingProductSchema>;
export type FundingCatalog = z.infer<typeof fundingCatalogSchema>;
export function productVersionKey(product: { productKey: string; version: string }): string {
  return `${product.productKey}@${product.version}`;
}
