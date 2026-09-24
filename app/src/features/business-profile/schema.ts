import Decimal from 'decimal.js';
import { z } from 'zod';

const AREA_PATTERN = /^\d+(?:\.\d{1,2})?$/;

// Zod는 앞 검사가 실패해도 다음 검사를 실행한다. 형식이 틀린 값을 Decimal에 넣으면 예외가 나서
// 400 대신 500이 되므로, 범위 검사는 형식이 맞을 때만 한다(형식 오류는 앞 검사가 보고한다).
const positiveDecimalString = z
  .string()
  .trim()
  .regex(AREA_PATTERN, '면적은 소수 둘째 자리까지 입력해 주세요.')
  .refine((value) => {
    if (!AREA_PATTERN.test(value)) return true;
    const decimal = new Decimal(value);
    return decimal.greaterThan(0) && decimal.lessThanOrEqualTo(10_000);
  }, '면적은 0보다 크고 10,000 이하여야 합니다.');

export const businessProfileInputSchema = z.object({
  districtCode: z.string().regex(/^\d{5}$/, '서울 자치구 코드를 선택해 주세요.'),
  marketIndustryCode: z.enum(['CS100001', 'CS100010']),
  detailedIndustryCode: z.string().trim().min(2).max(20).nullable(),
  area: z.object({ value: positiveDecimalString, unit: z.enum(['PYEONG', 'SQUARE_METERS']) }),
  floor: z.enum(['BASEMENT_1', 'GROUND_1', 'UPPER_2_PLUS']),
  buildingType: z.enum(['SMALL_RETAIL', 'MEDIUM_LARGE_RETAIL', 'COLLECTIVE_RETAIL']),
});

export const businessProfileUpdateSchema = z.object({
  businessProfile: businessProfileInputSchema.nullable(),
  revision: z.number().int().positive(),
});

export type BusinessProfileInput = z.infer<typeof businessProfileInputSchema>;

export type StoredBusinessProfile = BusinessProfileInput & {
  schemaVersion: 'business-profile-v1.0.0';
  districtName: string;
  marketIndustryName: string;
  detailedIndustryName: string | null;
  provenance: {
    marketReleaseKey: string;
    businessDirectoryReleaseKey: string | null;
  };
};
