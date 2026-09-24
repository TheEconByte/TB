import { businessProfileInputSchema, type BusinessProfileInput } from './schema.ts';

// 계획 화면의 사업 조건 입력 상태. 서버에 보내기 전 판정은 서버와 같은 스키마로 한다.
export type BusinessProfileForm = {
  districtCode: string;
  marketIndustryCode: '' | 'CS100001' | 'CS100010';
  detailedIndustryCode: string;
  areaValue: string;
  areaUnit: 'PYEONG' | 'SQUARE_METERS';
  floor: '' | 'BASEMENT_1' | 'GROUND_1' | 'UPPER_2_PLUS';
  buildingType: '' | 'SMALL_RETAIL' | 'MEDIUM_LARGE_RETAIL' | 'COLLECTIVE_RETAIL';
};

export const EMPTY_BUSINESS_PROFILE_FORM: BusinessProfileForm = {
  districtCode: '',
  marketIndustryCode: '',
  detailedIndustryCode: '',
  areaValue: '',
  areaUnit: 'PYEONG',
  floor: '',
  buildingType: '',
};

export function businessProfileFormFromStored(value: unknown): BusinessProfileForm {
  if (!value || typeof value !== 'object') return EMPTY_BUSINESS_PROFILE_FORM;
  const stored = value as Record<string, unknown>;
  const area = stored.area && typeof stored.area === 'object' ? (stored.area as Record<string, unknown>) : {};
  return {
    districtCode: typeof stored.districtCode === 'string' ? stored.districtCode : '',
    marketIndustryCode:
      stored.marketIndustryCode === 'CS100001' || stored.marketIndustryCode === 'CS100010'
        ? stored.marketIndustryCode
        : '',
    detailedIndustryCode: typeof stored.detailedIndustryCode === 'string' ? stored.detailedIndustryCode : '',
    areaValue: typeof area.value === 'string' ? area.value : '',
    areaUnit: area.unit === 'SQUARE_METERS' ? 'SQUARE_METERS' : 'PYEONG',
    floor:
      stored.floor === 'BASEMENT_1' || stored.floor === 'GROUND_1' || stored.floor === 'UPPER_2_PLUS'
        ? stored.floor
        : '',
    buildingType:
      stored.buildingType === 'SMALL_RETAIL' ||
      stored.buildingType === 'MEDIUM_LARGE_RETAIL' ||
      stored.buildingType === 'COLLECTIVE_RETAIL'
        ? stored.buildingType
        : '',
  };
}

const areaValueSchema = businessProfileInputSchema.shape.area.shape.value;

// 빠졌거나 서버가 받지 않을 항목과, 그 항목을 입력하는 단계(0부터).
export function businessProfileMissingFields(form: BusinessProfileForm): Array<{ label: string; step: number }> {
  return [
    { label: '지역구', step: 0, missing: !form.districtCode },
    { label: '업종', step: 0, missing: !form.marketIndustryCode },
    { label: '면적', step: 1, missing: !areaValueSchema.safeParse(form.areaValue).success },
    { label: '층', step: 2, missing: !form.floor },
    { label: '상가 유형', step: 3, missing: !form.buildingType },
  ]
    .filter((field) => field.missing)
    .map(({ label, step }) => ({ label, step }));
}

export type BusinessProfileSaveState =
  { kind: 'EMPTY' } | { kind: 'COMPLETE'; payload: BusinessProfileInput } | { kind: 'INCOMPLETE'; missing: string[] };

// EMPTY는 사업 조건 없는 계획으로 저장한다(null). INCOMPLETE는 저장을 막는다. null로 보내면
// 서버가 저장된 조건을 비우므로, 일부만 입력한 상태로 저장하면 이전 조건이 조용히 지워진다.
export function businessProfileSaveState(form: BusinessProfileForm): BusinessProfileSaveState {
  const empty =
    !form.districtCode &&
    !form.marketIndustryCode &&
    !form.detailedIndustryCode &&
    form.areaValue.trim() === '' &&
    !form.floor &&
    !form.buildingType;
  if (empty) return { kind: 'EMPTY' };
  const candidate = {
    districtCode: form.districtCode,
    marketIndustryCode: form.marketIndustryCode,
    detailedIndustryCode: form.detailedIndustryCode || null,
    area: { value: form.areaValue.trim(), unit: form.areaUnit },
    floor: form.floor,
    buildingType: form.buildingType,
  };
  const parsed = businessProfileInputSchema.safeParse(candidate);
  if (parsed.success) return { kind: 'COMPLETE', payload: parsed.data };
  const missing = businessProfileMissingFields(form).map((field) => field.label);
  return { kind: 'INCOMPLETE', missing: missing.length > 0 ? missing : ['사업 조건'] };
}
