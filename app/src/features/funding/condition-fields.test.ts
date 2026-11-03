import { describe, expect, it } from 'vitest';
import { CONDITION_FIELD_NAMES, parseStoredConditions } from './condition-fields.ts';
import { conditionOutputSchema, verifyConditionOutput, type ConditionOutput } from './notice-extraction.ts';

// 맞춰 보기는 funding_condition_extractions.fields(jsonb)를 다시 읽는다. funding:sync가 저장한 값은 그대로 읽혀야 하고,
// 모양이 다른 값은 그 항목만 읽지 못함이어야 한다(ADR 0009 §3: 읽지 못함은 확인 필요).

const BODY = [
  '□ 신청대상 : 서울시 소재 예비창업자 및 업력 3년 이내 소상공인',
  '□ 연령 : 공고일 기준 만 39세 이하',
  '□ 지역 : 서울 강남구ㆍ서초구 소재 사업장(송파구 제외)',
  '□ 제외 : 음식점업, 유흥주점업',
  '□ 대상 : 여성 소상공인',
  '□ 접수기간 : 2026. 11. 2. ～ 2026. 11. 20.',
  '□ 지원내용 : 운영자금 대출',
].join('\n');

const OUTPUT: ConditionOutput = {
  businessStage: { mentioned: true, value: 'BOTH', quote: '예비창업자 및 업력 3년 이내 소상공인' },
  businessAge: { mentioned: true, value: { min: null, max: 3, maxExclusive: false }, quote: '업력 3년 이내' },
  age: { mentioned: true, value: { min: null, max: 39, maxExclusive: false }, quote: '만 39세 이하' },
  region: {
    mentioned: true,
    value: {
      scope: 'SEOUL_DISTRICTS',
      provinces: [],
      districts: ['강남구', '서초구'],
      excludedProvinces: [],
      excludedDistricts: ['송파구'],
    },
    quote: '서울 강남구ㆍ서초구 소재 사업장(송파구 제외)',
  },
  foodBusiness: { mentioned: true, value: 'EXCLUDED', quote: '제외 : 음식점업' },
  targetGroups: { mentioned: true, value: { groups: ['WOMEN'], note: null }, quote: '여성 소상공인' },
  applicationPeriod: {
    mentioned: true,
    value: { start: '2026-11-02', end: '2026-11-20', text: null },
    quote: '2026. 11. 2. ～ 2026. 11. 20.',
  },
  supportTypes: { mentioned: true, value: ['LOAN'], quote: '운영자금 대출' },
};

describe('parseStoredConditions', () => {
  it('funding:sync가 검증해 저장한 값을 그대로 읽는다', () => {
    const stored = JSON.parse(JSON.stringify(verifyConditionOutput(OUTPUT, BODY)));
    const parsed = parseStoredConditions(stored);
    expect(parsed).toEqual(stored);
    expect(Object.values(parsed).every((field) => field.status === 'READ')).toBe(true);
  });

  it('언급 없음·읽지 못함도 그대로 읽는다', () => {
    const stored = JSON.parse(
      JSON.stringify(
        verifyConditionOutput(
          {
            ...OUTPUT,
            age: { mentioned: false, value: null, quote: null },
            region: { ...OUTPUT.region, quote: '본문에 없는 인용 문장' },
          },
          BODY,
        ),
      ),
    );
    const parsed = parseStoredConditions(stored);
    expect(parsed.age).toEqual({ status: 'NOT_MENTIONED' });
    expect(parsed.region).toEqual({ status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' });
  });

  it('모양이 다른 항목은 그 항목만 읽지 못함이고 나머지는 그대로 읽는다', () => {
    const stored = JSON.parse(JSON.stringify(verifyConditionOutput(OUTPUT, BODY)));
    stored.age = { status: 'READ', value: { min: 19, max: 39 }, quote: '만 39세 이하' };
    stored.foodBusiness = { status: 'READ', value: 'MAYBE', quote: '제외 : 음식점업' };
    delete stored.targetGroups;
    const parsed = parseStoredConditions(stored);
    expect(parsed.age.status).toBe('UNREADABLE');
    expect(parsed.foodBusiness.status).toBe('UNREADABLE');
    expect(parsed.targetGroups.status).toBe('UNREADABLE');
    expect(parsed.businessAge.status).toBe('READ');
  });

  it('객체가 아니면 모든 항목이 읽지 못함이다', () => {
    const parsed = parseStoredConditions(null);
    expect(CONDITION_FIELD_NAMES.map((name) => parsed[name].status)).toEqual(
      CONDITION_FIELD_NAMES.map(() => 'UNREADABLE'),
    );
  });

  it('항목 이름이 AI 출력 스키마와 같다', () => {
    expect([...CONDITION_FIELD_NAMES].sort()).toEqual(Object.keys(conditionOutputSchema.shape).sort());
  });
});
