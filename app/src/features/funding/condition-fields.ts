import { z } from 'zod';

// 공고 본문에서 AI가 읽은 조건의 이름·선택지·저장 모양(ADR 0009 §3). funding:sync의 추출(notice-extraction.ts)과 웹 요청의
// 맞춰 보기가 함께 쓴다. 웹 요청 경로가 import하므로 Anthropic SDK와 notice-extraction.ts를 import하지 않는다.

// 사용자 결정(2026-11-02). 바꾸면 같은 본문도 새로 추출한다(캐시 키의 일부).
export const CONDITION_MODEL = 'claude-haiku-5-5';
// 프롬프트, 출력 스키마, 검증 규칙(notice-extraction.ts의 verifyConditionOutput) 중 하나라도 바꾸면 올린다. 저장한 fields는
// 저장할 때의 검증 결과라서, 올리지 않으면 이미 읽은 본문은 옛 규칙의 결과로 남는다.
// v3(2026-11-03): 음식점·카페 제외의 뜻을 밝혔다(유흥주점 등만 빼면 제외 아님, 지원 업종 목록에 음식점·카페가 없으면 제외 업종
// 문장과 상관없이 제외).
// v4(2026-11-04): 출력 스키마에서 quote가 null 대신 빈 문자열을 받는다(API의 anyOf·type 배열 칸 한도 16개). 밝혔지만
// 형식으로 옮길 수 없는 조건은 value를 null로 두라고 밝혔다(빈 범위·빈 목록은 제한 없음으로 읽힌다).
// v5(2026-11-12): 프롬프트를 다시 썼다. 목적과 신청 자격을 가리는 기준을 밝히고, 지어낸 공고의 예시를 넣었다. 조건 추출 평가의
// 정답을 따른다(서울 밖 시·군은 그 시·도, 업종 한정은 음식점·카페 제외, 소상공인·기업은 사업자만). 출력 스키마는 그대로다.
// v6(2026-11-12): 대상·제외 자치구는 대상 시·도가 서울 하나일 때만 읽는다. 시·도가 빈 자치구 한정은 이제 읽지 못함이다
// (부산 중구가 서울 중구로 읽혔다). 프롬프트와 출력 스키마는 그대로다.
// v7(2026-11-12): 서울 전체는 시·도 서울, 자치구 한정은 자치구를 하나 이상 적을 때만이라고 밝히고, 서울 전체 예시를 넣었다
// (v6 동기화에서 서울 전체 공고 6건 중 3건을 자치구 없는 자치구 한정으로 적었다). 출력 스키마와 검증 규칙은 그대로다.
// v8(2026-11-13): 검증이 인용을 공고 제목(상품 이름)에서도 찾는다. 제목과 본문을 이은 인용은 받지 않는다(v7 동기화에서
// 인용으로 제목을 적은 공고의 지역이 버려졌다). 프롬프트와 출력 스키마는 그대로다.
export const CONDITION_PROMPT_VERSION = 'funding-conditions-v8';

export const CONDITION_BUSINESS_STAGES = ['PRE_STARTUP_ONLY', 'BUSINESS_ONLY', 'BOTH'] as const;
export const CONDITION_FOOD_BUSINESS = ['EXCLUDED', 'NOT_EXCLUDED'] as const;
export const CONDITION_REGION_SCOPES = ['NATIONWIDE', 'PROVINCES', 'SEOUL_DISTRICTS'] as const;
export const CONDITION_TARGET_GROUPS = ['YOUTH', 'WOMEN', 'DISABLED', 'RESTART', 'DAMAGED', 'OTHER'] as const;
export const CONDITION_SUPPORT_TYPES = ['LOAN', 'GUARANTEE', 'GRANT', 'SPACE', 'PROGRAM', 'OTHER'] as const;

export type ConditionTargetGroup = (typeof CONDITION_TARGET_GROUPS)[number];

// 범위. null인 쪽은 제한이 없다. maxExclusive가 true면 max 미만, false면 max 이하다.
export type ConditionRange = { min: number | null; max: number | null; maxExclusive: boolean };

// 검증을 거친 값. 지역은 시·도를 짧은 이름으로 맞추고 서울 자치구 이름을 코드로도 바꿔 둔다(맞춰 보기는 코드로 한다).
export type ConditionValues = {
  businessStage: (typeof CONDITION_BUSINESS_STAGES)[number];
  // 업력(년). 둘 다 null이면 업력 제한이 없다고 밝힌 것이다.
  businessAge: ConditionRange;
  // 대표자 만 나이.
  age: ConditionRange;
  region: {
    scope: (typeof CONDITION_REGION_SCOPES)[number];
    provinces: string[];
    districts: string[];
    excludedProvinces: string[];
    excludedDistricts: string[];
    districtCodes: string[];
    excludedDistrictCodes: string[];
  };
  foodBusiness: (typeof CONDITION_FOOD_BUSINESS)[number];
  // 빈 목록이면 특정 대상으로 한정하지 않는다고 밝힌 것이다.
  targetGroups: { groups: ConditionTargetGroup[]; note: string | null };
  applicationPeriod: { start: string | null; end: string | null; text: string | null };
  supportTypes: Array<(typeof CONDITION_SUPPORT_TYPES)[number]>;
};

export type ConditionFieldName = keyof ConditionValues;

export const CONDITION_FIELD_NAMES: readonly ConditionFieldName[] = [
  'businessStage',
  'businessAge',
  'age',
  'region',
  'foodBusiness',
  'targetGroups',
  'applicationPeriod',
  'supportTypes',
];

export type VerifiedField<T> =
  | { status: 'READ'; value: T; quote: string }
  | { status: 'NOT_MENTIONED' }
  // 값이나 인용이 없거나, 인용이 공고 제목과 본문에 없거나, 값이 말이 안 된다. 언급 없음과 섞지 않는다.
  | { status: 'UNREADABLE'; reason: string };

export type VerifiedConditions = { [K in ConditionFieldName]: VerifiedField<ConditionValues[K]> };

// 저장된 fields(jsonb)를 다시 읽을 때의 모양. funding:sync가 저장한 값만 받고, 다르면 그 항목만 읽지 못함으로 둔다.
const range = z.object({ min: z.number().nullable(), max: z.number().nullable(), maxExclusive: z.boolean() });
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const STORED_VALUES: { [K in ConditionFieldName]: z.ZodType<ConditionValues[K]> } = {
  businessStage: z.enum(CONDITION_BUSINESS_STAGES),
  businessAge: range,
  age: range,
  region: z.object({
    scope: z.enum(CONDITION_REGION_SCOPES),
    provinces: z.array(z.string()),
    districts: z.array(z.string()),
    excludedProvinces: z.array(z.string()),
    excludedDistricts: z.array(z.string()),
    districtCodes: z.array(z.string().regex(/^\d{5}$/)),
    excludedDistrictCodes: z.array(z.string().regex(/^\d{5}$/)),
  }),
  foodBusiness: z.enum(CONDITION_FOOD_BUSINESS),
  targetGroups: z.object({ groups: z.array(z.enum(CONDITION_TARGET_GROUPS)), note: z.string().nullable() }),
  applicationPeriod: z.object({ start: date.nullable(), end: date.nullable(), text: z.string().nullable() }),
  supportTypes: z.array(z.enum(CONDITION_SUPPORT_TYPES)).min(1),
};

const STORED_UNREADABLE = '저장된 추출 결과의 모양이 지금 앱과 맞지 않아 읽지 못했습니다.';

function parseField<K extends ConditionFieldName>(name: K, value: unknown): VerifiedField<ConditionValues[K]> {
  const entry = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  if (entry.status === 'NOT_MENTIONED') return { status: 'NOT_MENTIONED' };
  if (entry.status === 'UNREADABLE' && typeof entry.reason === 'string')
    return { status: 'UNREADABLE', reason: entry.reason };
  if (entry.status === 'READ' && typeof entry.quote === 'string') {
    const parsed = STORED_VALUES[name].safeParse(entry.value);
    if (parsed.success) return { status: 'READ', value: parsed.data, quote: entry.quote };
  }
  return { status: 'UNREADABLE', reason: STORED_UNREADABLE };
}

export function parseStoredConditions(value: unknown): VerifiedConditions {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return Object.fromEntries(
    CONDITION_FIELD_NAMES.map((name) => [name, parseField(name, stored[name])]),
  ) as VerifiedConditions;
}
