import { describe, expect, it } from 'vitest';
import { expectedFields, gradeCase, type GoldCase, type GoldField } from './condition-eval.ts';
import type { VerifiedConditions } from './condition-fields.ts';

// 공고 조건 추출 평가의 채점(ADR 0009 §3). 사용자에게 위험한 오답(AI가 읽었다면서 틀린 값 → 잘못된 맞음)과
// 안전한 오답(못 읽음 → 확인 필요)을 따로 세야 프롬프트를 고칠 때 어느 쪽으로 움직였는지 보인다.

const BODY = [
  '□ 신청대상 : 서울시 소재 업력 3년 이내 소상공인',
  '□ 연령 : 공고일 기준 만 39세 이하',
  '□ 지원내용 : 경영 컨설팅 및 판로 지원',
].join('\n');

const notMentioned: GoldField = { mentioned: false, value: null, quote: '', confidence: 'clear' };

function gold(fields: Partial<GoldCase['fields']> = {}): GoldCase {
  return {
    id: 'c00',
    productKey: 'bizinfo-pbln-test',
    textChecksum: 'x',
    productName: '청년 창업 지원',
    stratum: 'test',
    fields: {
      businessStage: { mentioned: true, value: 'BUSINESS_ONLY', quote: '업력 3년 이내 소상공인', confidence: 'clear' },
      businessAge: {
        mentioned: true,
        value: { min: null, max: 3, maxExclusive: false },
        quote: '업력 3년 이내 소상공인',
        confidence: 'clear',
      },
      age: {
        mentioned: true,
        value: { min: null, max: 39, maxExclusive: false },
        quote: '만 39세 이하',
        confidence: 'clear',
      },
      region: {
        mentioned: true,
        value: { scope: 'PROVINCES', provinces: ['서울'], districts: [], excludedProvinces: [], excludedDistricts: [] },
        quote: '서울시 소재 업력 3년 이내',
        confidence: 'clear',
      },
      foodBusiness: notMentioned,
      targetGroups: notMentioned,
      applicationPeriod: notMentioned,
      supportTypes: { mentioned: true, value: ['PROGRAM'], quote: '경영 컨설팅 및 판로 지원', confidence: 'clear' },
      ...fields,
    },
  };
}

// 정답을 그대로 AI 결과로 쓰면 저장 모양(검증을 거친 값)이 된다.
function asActual(expected: ReturnType<typeof expectedFields>['acceptable']): VerifiedConditions {
  return Object.fromEntries(
    Object.entries(expected).map(([name, options]) => [name, options[0]]),
  ) as VerifiedConditions;
}

const nothingRead = Object.fromEntries(
  Object.keys(gold().fields).map((name) => [name, { status: 'NOT_MENTIONED' }]),
) as VerifiedConditions;

describe('expectedFields', () => {
  it('turns gold labels into the stored shape through the real verification', () => {
    const { acceptable, problems } = expectedFields(gold(), BODY);
    expect(problems).toEqual([]);
    expect(acceptable.age[0]).toEqual({
      status: 'READ',
      value: { min: null, max: 39, maxExclusive: false },
      quote: '만 39세 이하',
    });
    expect(acceptable.foodBusiness).toEqual([{ status: 'NOT_MENTIONED' }]);
  });

  // 정답 인용이 본문에 없으면 정답 자체가 틀렸다. 채점에 쓰지 않고 알린다.
  it('reports a gold label whose quote is not in the body', () => {
    const { problems } = expectedFields(gold({ age: { ...gold().fields.age, quote: '만 34세 이하' } }), BODY);
    expect(problems).toEqual([expect.stringContaining('age')]);
  });
});

describe('gradeCase', () => {
  it('scores the gold answer itself as fully correct (oracle)', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    expect(gradeCase(asActual(acceptable), acceptable).scores).toEqual({
      field_acc: 1,
      exact_acc: 1,
      confident_wrong: 0,
      missed: 0,
    });
  });

  // 아무것도 못 읽으면 위험한 오답은 없고, 정답이 읽음인 칸은 모두 놓침이다.
  it('counts reading nothing as safe misses, not confident errors (null output)', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const { scores, outcomes } = gradeCase(nothingRead, acceptable);
    expect(scores.confident_wrong).toBe(0);
    expect(scores.missed).toBe(5 / 8);
    expect(scores.field_acc).toBe(3 / 8);
    expect(outcomes.age).toBe('MISSED');
    expect(outcomes.foodBusiness).toBe('CORRECT');
  });

  // "39세 이하"를 "제한 없음"으로 읽으면 55세 사용자도 맞음이 된다.
  it('counts a read value that differs from the gold as a confident error', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const actual = asActual(acceptable);
    actual.age = { status: 'READ', value: { min: null, max: null, maxExclusive: false }, quote: '만 39세 이하' };
    actual.foodBusiness = { status: 'READ', value: 'NOT_EXCLUDED', quote: '경영 컨설팅 및 판로 지원' };
    const { outcomes, scores } = gradeCase(actual, acceptable);
    expect(outcomes.age).toBe('CONFIDENT_WRONG');
    expect(outcomes.foodBusiness).toBe('CONFIDENT_WRONG');
    expect(scores.confident_wrong).toBe(2 / 8);
  });

  // 둘 다 화면에서 확인 필요가 되므로 맞춰 보기에는 같다. 정확도에는 넣고 완전 일치에는 넣지 않는다.
  it('treats not mentioned and unreadable as equivalent for matching but not exact', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const actual = asActual(acceptable);
    actual.foodBusiness = { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' };
    const { outcomes, scores } = gradeCase(actual, acceptable);
    expect(outcomes.foodBusiness).toBe('EQUIVALENT');
    expect(scores).toMatchObject({ field_acc: 1, exact_acc: 7 / 8 });
  });

  it('accepts an alternative answer listed for an ambiguous gold field', () => {
    const ambiguous = gold({
      businessStage: {
        mentioned: true,
        value: 'BUSINESS_ONLY',
        quote: '업력 3년 이내 소상공인',
        confidence: 'ambiguous',
        alternatives: ['BOTH'],
      },
    });
    const { acceptable } = expectedFields(ambiguous, BODY);
    const actual = asActual(acceptable);
    actual.businessStage = { status: 'READ', value: 'BOTH', quote: '업력 3년 이내 소상공인' };
    expect(gradeCase(actual, acceptable).outcomes.businessStage).toBe('CORRECT');
  });

  // 대안 null은 "언급 없음으로 봐도 된다"는 뜻이다. 그때 못 읽은 것은 놓침이 아니다.
  it('accepts not reading a field whose gold lists null as an alternative', () => {
    const optional = gold({
      age: { ...gold().fields.age, confidence: 'ambiguous', alternatives: [null] },
    });
    const { acceptable } = expectedFields(optional, BODY);
    const actual = asActual(acceptable);
    actual.age = { status: 'NOT_MENTIONED' };
    expect(gradeCase(actual, acceptable).outcomes.age).toBe('CORRECT');
    actual.age = { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' };
    expect(gradeCase(actual, acceptable).outcomes.age).toBe('EQUIVALENT');
  });

  // 주 정답이 언급 없음이면 인용이 없다. 대안 값은 인용 없이도 값 검사만 거쳐 인정한다.
  it('accepts a read alternative for a gold field that is not mentioned', () => {
    const optional = gold({
      targetGroups: {
        ...notMentioned,
        confidence: 'ambiguous',
        alternatives: [{ groups: ['OTHER'], note: '매출 한도' }],
      },
    });
    const { acceptable, problems } = expectedFields(optional, BODY);
    expect(problems).toEqual([]);
    const actual = asActual(acceptable);
    actual.targetGroups = { status: 'READ', value: { groups: ['OTHER'], note: null }, quote: '업력 3년 이내 소상공인' };
    expect(gradeCase(actual, acceptable).outcomes.targetGroups).toBe('CORRECT');
    actual.targetGroups = { status: 'NOT_MENTIONED' };
    expect(gradeCase(actual, acceptable).outcomes.targetGroups).toBe('CORRECT');
  });

  // 순서·표기만 다른 값과 맞춰 보기에 쓰지 않는 글(신청기간 원문 표기, 대상 메모)은 틀림으로 보지 않는다.
  it('ignores list order and free-text notes when comparing values', () => {
    const withPeriod = gold({
      supportTypes: {
        mentioned: true,
        value: ['PROGRAM', 'GRANT'],
        quote: '경영 컨설팅 및 판로 지원',
        confidence: 'clear',
      },
    });
    const { acceptable } = expectedFields(withPeriod, BODY);
    const actual = asActual(acceptable);
    actual.supportTypes = { status: 'READ', value: ['GRANT', 'PROGRAM'], quote: '경영 컨설팅 및 판로 지원' };
    expect(gradeCase(actual, acceptable).outcomes.supportTypes).toBe('CORRECT');
  });
});
