import { z } from 'zod';
import { todayInKst } from './dates.ts';
import { SEOUL_DISTRICTS } from './districts.ts';
import { USER_TARGET_GROUPS, type FundingMatchProfile } from './matching.ts';

// 맞춰 보기에 쓰는 사용자 입력(ADR 0009 §4). 페이지 단위 조회 본문과 계획의 자금 조건(plans.fundingProfileJson)이 같은
// 스키마를 쓴다. matching.ts는 형식을 다시 검사하지 않으므로 여기서 막는다: 개업 연월은 실제 달이고 이번 달까지, 나이는
// 정수, 자치구는 서울 자치구 코드다. 업종·용도는 받지 않는다(연결할 데이터가 없다).

const SEOUL_DISTRICT_CODES = new Set(SEOUL_DISTRICTS.map((district) => district.code));

export function isSeoulDistrictCode(value: unknown): value is string {
  return typeof value === 'string' && SEOUL_DISTRICT_CODES.has(value);
}

export const YEAR_MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

// 개업 연월이 이번 달보다 늦은지. 이번 달은 판정 기준일과 같은 한국 시간 날짜로 정한다.
export function isFutureYearMonth(value: string, now: Date = new Date()): boolean {
  return value > todayInKst(now).slice(0, 7);
}

// 0~120은 AI가 읽은 나이 조건을 받아들이는 범위와 같다(notice-extraction.ts).
export const MAX_AGE = 120;

function profileSchema(options: { rejectFutureMonth: boolean }) {
  return z
    .strictObject({
      businessStatus: z.enum(['PRE_STARTUP', 'BUSINESS']).nullable(),
      openedYearMonth: z
        .string()
        .regex(YEAR_MONTH_PATTERN, '개업 연월은 2024-03처럼 연도와 01~12월로 입력해 주세요.')
        .refine(
          (value) => !options.rejectFutureMonth || !YEAR_MONTH_PATTERN.test(value) || !isFutureYearMonth(value),
          '개업 연월은 이번 달보다 늦을 수 없습니다.',
        )
        .nullable(),
      districtCode: z.string().refine(isSeoulDistrictCode, '서울 자치구를 골라 주세요.').nullable(),
      age: z
        .number()
        .int('나이는 정수로 입력해 주세요.')
        .min(0, `나이는 0~${MAX_AGE} 사이로 입력해 주세요.`)
        .max(MAX_AGE, `나이는 0~${MAX_AGE} 사이로 입력해 주세요.`)
        .nullable(),
      // null은 답하지 않음, 빈 목록은 해당 없음이다(matching.ts).
      targetGroups: z
        .array(z.enum(USER_TARGET_GROUPS))
        .refine((groups) => new Set(groups).size === groups.length, '대상 한정을 한 번씩만 골라 주세요.')
        .nullable(),
    })
    .refine((profile) => profile.openedYearMonth === null || profile.businessStatus === 'BUSINESS', {
      path: ['openedYearMonth'],
      message: '개업 연월은 사업자일 때만 입력합니다.',
    });
}

// 새로 받는 값(요청 본문·계획 저장)의 스키마.
export const fundingMatchProfileSchema = profileSchema({ rejectFutureMonth: true });
// 저장된 값을 읽을 때는 이번 달 검사를 다시 하지 않는다. 저장할 때 검사했고, 읽는 쪽(브라우저 등)의 시계가 늦어도
// 저장한 조건을 버리지 않기 위해서다.
const storedProfileSchema = profileSchema({ rejectFutureMonth: false });

// 5c 전의 계획 자금 조건. 사업 단계와 자치구만 옮기고 업종·용도는 버린다(사용자 결정 2026-11-03). 예전 스키마도 네 키만
// 받았다. 버리는 두 값은 형식을 따지지 않는다.
const legacyProfileSchema = z.strictObject({
  businessStage: z.enum(['PRE_REGISTRATION', 'POST_REGISTRATION', 'UNKNOWN']),
  districtCode: z.string().refine(isSeoulDistrictCode).nullable(),
  industryCode: z.unknown().optional(),
  purpose: z.unknown().optional(),
});

const LEGACY_STAGES = { PRE_REGISTRATION: 'PRE_STARTUP', POST_REGISTRATION: 'BUSINESS', UNKNOWN: null } as const;

export type StoredFundingProfile =
  | { kind: 'NONE' }
  // legacy는 예전 모양에서 옮긴 값이다. 다음 저장 때 지금 모양으로 쓴다.
  | { kind: 'OK'; profile: FundingMatchProfile; legacy: boolean }
  | { kind: 'INVALID'; error: z.ZodError };

// 계획에 저장된 자금 조건을 읽는다. 어느 모양에도 맞지 않으면 다른 값으로 해석하지 않는다.
export function readStoredFundingProfile(value: unknown): StoredFundingProfile {
  if (value === null || value === undefined) return { kind: 'NONE' };
  const current = storedProfileSchema.safeParse(value);
  if (current.success) return { kind: 'OK', profile: current.data, legacy: false };
  const legacy = legacyProfileSchema.safeParse(value);
  if (legacy.success) {
    // 예전 입력에 없던 항목은 입력하지 않음이다. 해당 없음이나 다른 값으로 지어내지 않는다.
    return {
      kind: 'OK',
      legacy: true,
      profile: {
        businessStatus: LEGACY_STAGES[legacy.data.businessStage],
        openedYearMonth: null,
        districtCode: legacy.data.districtCode,
        age: null,
        targetGroups: null,
      },
    };
  }
  return { kind: 'INVALID', error: current.error };
}

// 맞춰 본 자치구가 어디서 왔는지. null은 어디에도 없다.
export type DistrictSource = 'FUNDING_PROFILE' | 'BUSINESS_PROFILE' | null;

// 계획의 사업 프로필(businessProfileJson)에 저장된 자치구. 저장할 때 검증했지만, 서울 자치구 코드가 아니면 쓰지 않는다.
export function businessProfileDistrict(businessProfileJson: unknown): string | null {
  if (typeof businessProfileJson !== 'object' || businessProfileJson === null) return null;
  const code = (businessProfileJson as { districtCode?: unknown }).districtCode;
  return isSeoulDistrictCode(code) ? code : null;
}

// 자치구는 자금 조건의 것을 쓰고, 비어 있으면 계획의 사업 프로필 것을 쓴다(ADR 0009 §4). 서버가 정해 matching.ts에 넘긴다.
export function withBusinessDistrict(
  profile: FundingMatchProfile,
  businessProfileJson: unknown,
): { profile: FundingMatchProfile; districtSource: DistrictSource } {
  if (profile.districtCode !== null) return { profile, districtSource: 'FUNDING_PROFILE' };
  const districtCode = businessProfileDistrict(businessProfileJson);
  return districtCode === null
    ? { profile, districtSource: null }
    : { profile: { ...profile, districtCode }, districtSource: 'BUSINESS_PROFILE' };
}
