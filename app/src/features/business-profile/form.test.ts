import { describe, expect, it } from 'vitest';
import {
  EMPTY_BUSINESS_PROFILE_FORM,
  businessProfileFormFromStored,
  businessProfileMissingFields,
  businessProfileSaveState,
  type BusinessProfileForm,
} from './form.ts';
import { businessProfileInputSchema } from './schema.ts';

const complete: BusinessProfileForm = {
  districtCode: '11200',
  marketIndustryCode: 'CS100010',
  detailedIndustryCode: '',
  areaValue: '10',
  areaUnit: 'PYEONG',
  floor: 'GROUND_1',
  buildingType: 'SMALL_RETAIL',
};

describe('사업 조건 저장 판정', () => {
  it('아무것도 입력하지 않으면 조건 없는 계획으로 저장한다', () => {
    expect(businessProfileSaveState(EMPTY_BUSINESS_PROFILE_FORM)).toEqual({ kind: 'EMPTY' });
    // 면적 단위만 바꾼 것은 입력으로 보지 않는다.
    expect(
      businessProfileSaveState({ ...EMPTY_BUSINESS_PROFILE_FORM, areaUnit: 'SQUARE_METERS', areaValue: ' ' }),
    ).toEqual({ kind: 'EMPTY' });
  });

  it('필수값이 모두 있으면 서버 스키마를 통과한 값을 보낸다', () => {
    expect(businessProfileSaveState({ ...complete, areaValue: ' 10.5 ' })).toEqual({
      kind: 'COMPLETE',
      payload: {
        districtCode: '11200',
        marketIndustryCode: 'CS100010',
        detailedIndustryCode: null,
        area: { value: '10.5', unit: 'PYEONG' },
        floor: 'GROUND_1',
        buildingType: 'SMALL_RETAIL',
      },
    });
  });

  it('일부만 입력하면 저장을 막고 빠진 항목을 입력 순서대로 알려 준다', () => {
    expect(businessProfileSaveState({ ...EMPTY_BUSINESS_PROFILE_FORM, floor: 'GROUND_1' })).toEqual({
      kind: 'INCOMPLETE',
      missing: ['지역구', '업종', '면적', '상가 유형'],
    });
    expect(businessProfileSaveState({ ...complete, buildingType: '' })).toEqual({
      kind: 'INCOMPLETE',
      missing: ['상가 유형'],
    });
  });

  it('서버가 거부하는 면적(0, 10,000 초과, 소수 셋째 자리)도 빠진 항목으로 본다', () => {
    for (const areaValue of ['0', '10000.01', '12.345', 'abc']) {
      expect(businessProfileSaveState({ ...complete, areaValue })).toEqual({ kind: 'INCOMPLETE', missing: ['면적'] });
    }
    expect(businessProfileMissingFields({ ...complete, areaValue: '0' })).toEqual([{ label: '면적', step: 1 }]);
  });

  it('저장된 조건을 폼으로 되돌리면 다시 완성 상태다', () => {
    const payload = businessProfileSaveState(complete);
    if (payload.kind !== 'COMPLETE') throw new Error(payload.kind);
    expect(businessProfileSaveState(businessProfileFormFromStored(payload.payload)).kind).toBe('COMPLETE');
    expect(businessProfileFormFromStored(null)).toEqual(EMPTY_BUSINESS_PROFILE_FORM);
  });
});

describe('사업 조건 서버 스키마', () => {
  it('형식이 틀린 면적에 예외 대신 검증 오류를 준다', () => {
    const base = {
      districtCode: '11200',
      marketIndustryCode: 'CS100010',
      detailedIndustryCode: null,
      floor: 'GROUND_1',
      buildingType: 'SMALL_RETAIL',
    };
    for (const value of ['', 'abc', '1e3', '-1']) {
      const parsed = businessProfileInputSchema.safeParse({ ...base, area: { value, unit: 'PYEONG' } });
      expect(parsed.success).toBe(false);
    }
    expect(businessProfileInputSchema.safeParse({ ...base, area: { value: '0', unit: 'PYEONG' } }).success).toBe(false);
    expect(
      businessProfileInputSchema.safeParse({ ...base, area: { value: '33.5', unit: 'SQUARE_METERS' } }).success,
    ).toBe(true);
  });
});
