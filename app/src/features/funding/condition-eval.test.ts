import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  EVAL_SETS,
  expectedFields,
  gradeCase,
  gradeGroups,
  summarizeBySet,
  type GoldCase,
  type GoldField,
} from './condition-eval.ts';
import type { ConditionValues, VerifiedConditions } from './condition-fields.ts';

// 공고 조건 추출 평가의 채점(ADR 0009 §3). 위험한 오답(어떤 사용자에게 정답과 다른 맞음·안 맞음을 냄)과 안전한
// 오답(정답과 달라도 확인 필요로만 바뀜)을 따로 세야 프롬프트를 고칠 때 어느 쪽으로 움직였는지 보인다.

const BODY = [
  '□ 신청대상 : 서울시 소재 업력 3년 이내 소상공인',
  '□ 연령 : 공고일 기준 만 39세 이하',
  '□ 지원내용 : 경영 컨설팅 및 판로 지원',
].join('\n');

const notMentioned: GoldField = { mentioned: false, value: null, quote: '', confidence: 'clear' };

function gold(fields: Partial<GoldCase['fields']> = {}): GoldCase {
  return {
    id: 'c00',
    set: 'dev',
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
  // 정답도 실제 검증을 거친다. 제목 구절을 인용한 정답이 검증을 통과하지 못하면 평가를 돌릴 수 없다(사용자 결정
  // 2026-11-12: 제목도 공고의 일부).
  it('accepts a gold answer quoted from the product name', () => {
    const region: GoldField = {
      mentioned: true,
      value: { scope: 'PROVINCES', provinces: ['부산'], districts: [], excludedProvinces: [], excludedDistricts: [] },
      quote: '[부산] 청년 창업 지원',
      confidence: 'clear',
    };
    const titled = gold({ region });
    const { acceptable, problems } = expectedFields({ ...titled, productName: '[부산] 청년 창업 지원' }, BODY);
    expect(problems).toEqual([]);
    expect(acceptable.region[0]).toMatchObject({ status: 'READ', value: { provinces: ['부산'] } });
  });

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

  // 정답 인용이 공고 제목과 본문에 없으면 정답 자체가 틀렸다. 채점에 쓰지 않고 알린다.
  it('reports a gold label whose quote is not in the body', () => {
    const { problems } = expectedFields(gold({ age: { ...gold().fields.age, quote: '만 34세 이하' } }), BODY);
    expect(problems).toEqual([expect.stringContaining('age')]);
  });
});

describe('gradeCase', () => {
  it('scores the gold answer itself as fully correct (oracle)', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    expect(gradeCase(asActual(acceptable), acceptable, null).scores).toEqual({
      field_acc: 1,
      exact_acc: 1,
      confident_wrong: 0,
      missed: 0,
      group_changed: 0,
      group_surfaced: 0,
    });
  });

  // 아무것도 못 읽으면 위험한 오답은 없고, 정답이 읽음인 칸은 모두 놓침이다.
  it('counts reading nothing as safe misses, not confident errors (null output)', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const { scores, outcomes } = gradeCase(nothingRead, acceptable, null);
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
    const { outcomes, scores } = gradeCase(actual, acceptable, null);
    expect(outcomes.age).toBe('CONFIDENT_WRONG');
    expect(outcomes.foodBusiness).toBe('CONFIDENT_WRONG');
    // 위험한 오답은 맞춰 보기에 쓰는 여섯 항목 중 비율이다.
    expect(scores.confident_wrong).toBe(2 / 6);
  });

  // 채점은 값의 모양이 아니라 맞춰 보기 판정으로 한다(리뷰 지적 2026-11-04). 서울 사용자에게 같은 결과면 같은 답이다.
  it('treats values with the same matching verdicts as the same answer', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const actual = asActual(acceptable);
    // 40세 미만과 39세 이하는 만 나이(정수)에서 같다.
    actual.age = { status: 'READ', value: { min: null, max: 40, maxExclusive: true }, quote: '만 39세 이하' };
    // 서울이 들어 있으면 다른 시·도가 더 있어도 서울 사용자에게는 같다.
    actual.region = {
      status: 'READ',
      value: {
        ...(acceptable.region[0] as { value: ConditionValues['region'] }).value,
        provinces: ['서울', '경기'],
      },
      quote: '서울시 소재 업력 3년 이내',
    };
    const { outcomes } = gradeCase(actual, acceptable, null);
    expect(outcomes.age).toBe('CORRECT');
    expect(outcomes.region).toBe('CORRECT');
  });

  // 둘 다 확인 필요다. 읽었다고 해서 위험한 오답은 아니다.
  it('does not count a read value that still ends in a check as a confident error', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const actual = asActual(acceptable);
    actual.targetGroups = {
      status: 'READ',
      value: { groups: ['OTHER'], note: '신용점수' },
      quote: '업력 3년 이내 소상공인',
    };
    expect(gradeCase(actual, acceptable, null).outcomes.targetGroups).toBe('EQUIVALENT');
  });

  // 언급 없는 지역을 전국으로 읽으면 확인 필요가 맞음이 된다.
  it('counts reading an unmentioned condition into a match as a confident error', () => {
    const noRegion = gold({ region: notMentioned });
    const { acceptable } = expectedFields(noRegion, BODY);
    const actual = asActual(acceptable);
    actual.region = {
      status: 'READ',
      value: {
        scope: 'NATIONWIDE',
        provinces: [],
        districts: [],
        excludedProvinces: [],
        excludedDistricts: [],
        districtCodes: [],
        excludedDistrictCodes: [],
      },
      quote: '서울시 소재 업력 3년 이내',
    };
    expect(gradeCase(actual, acceptable, null).outcomes.region).toBe('CONFIDENT_WRONG');
  });

  // 지원 방식은 화면에 보여 주기만 한다. 틀려도 맞음·안 맞음을 바꾸지 않으므로 위험한 오답과 따로 센다.
  it('counts a wrong display-only field apart from confident errors', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const actual = asActual(acceptable);
    actual.supportTypes = { status: 'READ', value: ['PROGRAM', 'GRANT', 'PROGRAM'], quote: '경영 컨설팅 및 판로 지원' };
    const { outcomes, scores } = gradeCase(actual, acceptable, null);
    expect(outcomes.supportTypes).toBe('DISPLAY_WRONG');
    expect(scores.confident_wrong).toBe(0);
    expect(scores.field_acc).toBe(7 / 8);
    // 같은 값이 겹쳐 들어온 것만으로는 틀림이 아니다.
    actual.supportTypes = { status: 'READ', value: ['PROGRAM', 'PROGRAM'], quote: '경영 컨설팅 및 판로 지원' };
    expect(gradeCase(actual, acceptable, null).outcomes.supportTypes).toBe('CORRECT');
  });

  // 확인 리뷰가 찾은 회귀(2026-11-05): 정해 둔 사용자 입력이 성겨 흔한 기준선 사이의 차이를 못 봤다. 입력은 비교하는
  // 두 값의 경계에서 만든다. 아래는 모두 실제 사용자를 잘못된 맞음·안 맞음으로 보내는 답이다.
  describe('differences near common thresholds', () => {
    const range = (min: number | null, max: number | null, maxExclusive = false) => ({ min, max, maxExclusive });
    const read = <T>(value: T, quote = '업력 3년 이내 소상공인') => ({ status: 'READ' as const, value, quote });

    it.each([
      ['7년 이내 → 10년 이내', range(null, 7), range(null, 10)],
      ['7년 이내 → 5년 이내', range(null, 7), range(null, 5)],
      ['1년 이상 → 2년 이상', range(1, null), range(2, null)],
    ])('business age: %s', (_, goldValue, actualValue) => {
      const { acceptable } = expectedFields(
        gold({ businessAge: { ...gold().fields.businessAge, value: goldValue } }),
        BODY,
      );
      const actual = asActual(acceptable);
      actual.businessAge = read(actualValue);
      expect(gradeCase(actual, acceptable, null).outcomes.businessAge).toBe('CONFIDENT_WRONG');
    });

    // 업력은 개업 연월(월 단위)로 재고 경계 달은 확인 필요다(matching.ts businessAgeJudgment). 채점 기준일(2026-11-04)에는
    // 7년 이하와 7년 미만이 모든 사용자에게 같다. 매달 1일·말일에만 갈리는 차이는 보지 않는다(알려진 한계, funding.md).
    it('business age: 7 years or less and under 7 years give the same results', () => {
      const { acceptable } = expectedFields(
        gold({ businessAge: { ...gold().fields.businessAge, value: range(null, 7) } }),
        BODY,
      );
      const actual = asActual(acceptable);
      actual.businessAge = read(range(null, 7, true));
      expect(gradeCase(actual, acceptable, null).outcomes.businessAge).toBe('CORRECT');
    });

    it.each([
      ['39세 이하 → 44세 이하', range(null, 39), range(null, 44)],
      ['39세 이하 → 40세 이하', range(null, 39), range(null, 40)],
      ['19세 이상 → 20세 이상', range(19, null), range(20, null)],
    ])('age: %s', (_, goldValue, actualValue) => {
      const { acceptable } = expectedFields(gold({ age: { ...gold().fields.age, value: goldValue } }), BODY);
      const actual = asActual(acceptable);
      actual.age = read(actualValue, '만 39세 이하');
      expect(gradeCase(actual, acceptable, null).outcomes.age).toBe('CONFIDENT_WRONG');
    });

    // 나이는 0~120세만 입력할 수 있다(match-profile.ts). 그 밖의 나이로 차이를 지어내지 않는다(리뷰 지적 2026-11-05).
    it.each([
      ['빈 하한을 0으로', range(null, 39), range(0, 39)],
      ['빈 상한을 120으로', range(19, null), range(19, 120)],
    ])('age: %s is the same answer', (_, goldValue, actualValue) => {
      const { acceptable } = expectedFields(gold({ age: { ...gold().fields.age, value: goldValue } }), BODY);
      const actual = asActual(acceptable);
      actual.age = read(actualValue, '만 39세 이하');
      expect(gradeCase(actual, acceptable, null).outcomes.age).toBe('CORRECT');
    });

    // 청년 기준 나이는 공고마다 다르다. 정답의 나이 경계에서 청년인 사용자와 아닌 사용자를 모두 본다.
    it('target groups: youth with a youth age other than 39', () => {
      const young = gold({
        age: { ...gold().fields.age, value: range(19, 24) },
        targetGroups: {
          mentioned: true,
          value: { groups: ['OTHER'], note: '매출' },
          quote: '업력 3년 이내 소상공인',
          confidence: 'clear',
        },
      });
      const { acceptable } = expectedFields(young, BODY);
      const actual = asActual(acceptable);
      actual.targetGroups = read({ groups: ['YOUTH', 'OTHER'], note: '매출' });
      expect(gradeCase(actual, acceptable, null).outcomes.targetGroups).toBe('CONFIDENT_WRONG');
    });

    // 울산 중구를 서울 중구로 읽으면 서울 중구 사용자에게 맞음이 된다. 서울 25개 자치구를 모두 본다.
    it('region: another city district read as a Seoul district', () => {
      const ulsan = gold({
        region: {
          mentioned: true,
          value: {
            scope: 'PROVINCES',
            provinces: ['울산'],
            districts: [],
            excludedProvinces: [],
            excludedDistricts: [],
          },
          quote: '서울시 소재 업력 3년 이내',
          confidence: 'clear',
        },
      });
      const { acceptable } = expectedFields(ulsan, BODY);
      const actual = asActual(acceptable);
      actual.region = read(
        {
          scope: 'SEOUL_DISTRICTS',
          provinces: ['서울'],
          districts: ['중구'],
          excludedProvinces: [],
          excludedDistricts: [],
          districtCodes: ['11140'],
          excludedDistrictCodes: [],
        },
        '서울시 소재 업력 3년 이내',
      );
      expect(gradeCase(actual, acceptable, null).outcomes.region).toBe('CONFIDENT_WRONG');
    });

    // 장애인 사용자가 확인 필요 대신 맞음이 된다. 대상 조합을 모두 본다.
    it('target groups: an extra group the gold does not have', () => {
      const other = gold({
        targetGroups: {
          mentioned: true,
          value: { groups: ['OTHER'], note: '매출' },
          quote: '업력 3년 이내 소상공인',
          confidence: 'clear',
        },
      });
      const { acceptable } = expectedFields(other, BODY);
      const actual = asActual(acceptable);
      actual.targetGroups = read({ groups: ['OTHER', 'DISABLED'], note: '매출' });
      expect(gradeCase(actual, acceptable, null).outcomes.targetGroups).toBe('CONFIDENT_WRONG');
    });
  });

  // 맞음·안 맞음이던 판정이 확인 필요로 바뀌기만 하면 안전한 쪽이다(리뷰 지적 2026-11-05). 위험한 추측을 확인 필요로
  // 바꾸는 프롬프트가 나빠 보이지 않게, 이런 차이는 놓침으로 센다.
  it('counts a reading that only turns decisions into checks as a safe miss', () => {
    const youth = gold({
      targetGroups: {
        mentioned: true,
        value: { groups: ['YOUTH'], note: null },
        quote: '만 39세 이하',
        confidence: 'clear',
      },
    });
    const { acceptable } = expectedFields(youth, BODY);
    const actual = asActual(acceptable);
    actual.targetGroups = { status: 'READ', value: { groups: ['OTHER'], note: '청년' }, quote: '만 39세 이하' };
    expect(gradeCase(actual, acceptable, null).outcomes.targetGroups).toBe('MISSED');
  });

  // 둘 다 항목 판정은 확인 필요다. 정확도에는 넣고 완전 일치에는 넣지 않는다. 화면의 그룹은 다를 수 있지만(언급 없음뿐이면
  // 걸리는 조건 안 보임) 채점은 항목의 판정만 본다.
  it('treats not mentioned and unreadable as equivalent for matching but not exact', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const actual = asActual(acceptable);
    actual.foodBusiness = { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' };
    const { outcomes, scores } = gradeCase(actual, acceptable, null);
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
    expect(gradeCase(actual, acceptable, null).outcomes.businessStage).toBe('CORRECT');
  });

  // 대안 null은 "언급 없음으로 봐도 된다"는 뜻이다. 그때 못 읽은 것은 놓침이 아니다.
  it('accepts not reading a field whose gold lists null as an alternative', () => {
    const optional = gold({
      age: { ...gold().fields.age, confidence: 'ambiguous', alternatives: [null] },
    });
    const { acceptable } = expectedFields(optional, BODY);
    const actual = asActual(acceptable);
    actual.age = { status: 'NOT_MENTIONED' };
    expect(gradeCase(actual, acceptable, null).outcomes.age).toBe('CORRECT');
    actual.age = { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' };
    expect(gradeCase(actual, acceptable, null).outcomes.age).toBe('EQUIVALENT');
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
    expect(gradeCase(actual, acceptable, null).outcomes.targetGroups).toBe('CORRECT');
    actual.targetGroups = { status: 'NOT_MENTIONED' };
    expect(gradeCase(actual, acceptable, null).outcomes.targetGroups).toBe('CORRECT');
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
    expect(gradeCase(actual, acceptable, null).outcomes.supportTypes).toBe('CORRECT');
  });
});

// 정답은 프롬프트를 고칠 때 보는 공고(dev)와 고친 뒤에만 재는 공고(test)로 나뉜다(사용자 결정 2026-11-12). dev만으로
// 재면 고칠 때 본 공고의 점수라 새 공고에서 나빠진 것을 모른다. 한 공고가 양쪽에 있으면 test가 dev를 다시 재는 셈이다.
// 화면의 그룹은 확인 필요의 이유도 본다(맞음이 아닌 항목이 언급 없음뿐이면 걸리는 조건 안 보임, ADR 0009 §4). 항목 채점이
// 같은 답이나 안전한 놓침으로 세는 차이가 공고를 앞 그룹으로 올릴 수 있어, 그룹을 따로 견준다.
describe('gradeGroups', () => {
  // 사업자·서울·업력과 나이 언급 없음인 공고. 사업자 입력에서 걸리는 조건 안 보임이다(사업 단계와 지역만 맞음).
  const open = (fields: Partial<GoldCase['fields']> = {}) =>
    gold({ businessAge: notMentioned, age: notMentioned, ...fields });
  const other: GoldField = {
    mentioned: true,
    value: { groups: ['OTHER'], note: '매출 상한' },
    quote: '업력 3년 이내 소상공인',
    confidence: 'clear',
  };

  it('keeps the gold answer in the same group for every input (oracle)', () => {
    const { acceptable } = expectedFields(open(), BODY);
    expect(gradeCase(asActual(acceptable), acceptable, null).groups).toEqual({
      NO_INPUT: 'SAME',
      PRE_STARTUP: 'SAME',
      BUSINESS: 'SAME',
    });
  });

  // 공고가 밝힌 '그 밖의 대상'을 언급 없음으로 적으면 항목 채점은 같은 답이지만, 사업자에게 확인 필요여야 할 공고가 걸리는
  // 조건 안 보임으로 올라간다. 예비 창업자에게는 사업 단계가 안 맞아 어느 쪽이든 안 맞아 보임이다.
  it('counts a stated restriction recorded as not mentioned as wrongly surfaced', () => {
    const { acceptable } = expectedFields(open({ targetGroups: other }), BODY);
    const actual = asActual(acceptable);
    actual.targetGroups = { status: 'NOT_MENTIONED' };
    const { outcomes, groups, scores } = gradeCase(actual, acceptable, null);
    expect(outcomes.targetGroups).toBe('EQUIVALENT');
    expect(groups).toEqual({ NO_INPUT: 'SAME', PRE_STARTUP: 'SAME', BUSINESS: 'SURFACED' });
    expect(scores).toMatchObject({ field_acc: 1, group_changed: 1 / 3, group_surfaced: 1 / 3 });
  });

  it('counts an unmentioned condition recorded as unreadable as a change, not as surfaced', () => {
    const { acceptable } = expectedFields(open(), BODY);
    const actual = asActual(acceptable);
    actual.foodBusiness = { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' };
    const { groups, scores } = gradeCase(actual, acceptable, null);
    expect(groups.BUSINESS).toBe('OTHER');
    expect(scores).toMatchObject({ group_changed: 1 / 3, group_surfaced: 0 });
  });

  // 제한 조건을 못 읽어 안 맞아 보임이어야 할 공고가 확인 필요로 가는 것은 안전한 놓침이다. 앞 그룹 쪽으로 움직였어도 사용자가
  // 먼저 보는 두 그룹에 들어온 것이 아니므로 잘못 올라옴으로 세지 않는다(2026-11-13 측정에서 이런 회차가 9회였다).
  it('does not count a not-matching notice that lands in needs-check as surfaced', () => {
    const { acceptable } = expectedFields(gold(), BODY);
    const actual = asActual(acceptable);
    actual.age = { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' };
    const { outcomes, groups, scores } = gradeCase(actual, acceptable, null);
    expect(outcomes.age).toBe('MISSED');
    expect(groups.BUSINESS).toBe('OTHER');
    expect(scores.group_surfaced).toBe(0);
  });

  // 인정하는 정답이 여럿이면 어느 것이 먼저 적혔는지가 결과를 바꾸면 안 된다.
  it('gives the same result whichever accepted answer is listed first', () => {
    const { acceptable } = expectedFields(gold({ age: { ...gold().fields.age, alternatives: [null] } }), BODY);
    const actual = asActual(acceptable);
    actual.age = { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' };
    const swapped = { ...acceptable, age: [...acceptable.age].reverse() };
    expect(gradeGroups(actual, acceptable, null)).toEqual(gradeGroups(actual, swapped, null));
    expect(gradeGroups(actual, acceptable, null).BUSINESS).toBe('OTHER');
  });

  // 정답이 언급 없음도 인정하는 칸이면, 그렇게 적어 생긴 그룹도 정답이다.
  it('accepts the group of an alternative answer', () => {
    const { acceptable } = expectedFields(open({ targetGroups: { ...other, alternatives: [null] } }), BODY);
    const actual = asActual(acceptable);
    actual.targetGroups = { status: 'NOT_MENTIONED' };
    expect(gradeCase(actual, acceptable, null).groups.BUSINESS).toBe('SAME');
  });

  // 화면은 지역이 언급 없음이고 제목에 다른 지역 표시가 있으면 확인 필요에 둔다. 평가도 같은 판단을 써야 한다.
  it('uses the title region mark the way the screen does', () => {
    const marked = { ...open({ region: notMentioned }), productName: '[부산] 청년 창업 지원' };
    const { acceptable, titleRegionMark } = expectedFields(marked, BODY);
    expect(titleRegionMark).toBe('부산');
    const actual = asActual(acceptable);
    actual.foodBusiness = { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' };
    // 표시가 없으면 정답은 걸리는 조건 안 보임이라 내려간 것이고, 표시가 있으면 둘 다 확인 필요다.
    expect(gradeCase(actual, acceptable, null).groups.BUSINESS).toBe('OTHER');
    expect(gradeCase(actual, acceptable, titleRegionMark).groups.BUSINESS).toBe('SAME');
    expect(expectedFields({ ...marked, productKey: 'semas-ols-direct-x' }, BODY).titleRegionMark).toBeNull();
  });
});

describe('the gold cases', () => {
  const cases = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../../eval/funding-conditions/cases.json', import.meta.url)), 'utf8'),
  ) as GoldCase[];

  it('put every case in exactly one set, and both sets have cases', () => {
    for (const item of cases) expect(EVAL_SETS, item.id).toContain(item.set);
    expect(new Set(cases.map((item) => item.id)).size).toBe(cases.length);
    for (const set of EVAL_SETS)
      expect(
        cases.some((item) => item.set === set),
        set,
      ).toBe(true);
  });

  it('do not share a notice between the sets', () => {
    const inDev = cases.filter((item) => item.set === 'dev');
    const shared = cases
      .filter((item) => item.set === 'test')
      .filter((item) =>
        inDev.some((dev) => dev.productKey === item.productKey || dev.textChecksum === item.textChecksum),
      )
      .map((item) => item.id);
    expect(shared).toEqual([]);
  });
});

describe('summarizeBySet', () => {
  const testCase = (id: string): GoldCase => ({ ...gold(), id, set: 'test' });
  const devCase = (id: string): GoldCase => ({ ...gold(), id, set: 'dev' });
  const { acceptable } = expectedFields(gold(), BODY);
  const perfect = gradeCase(asActual(acceptable), acceptable, null);
  const blank = gradeCase(nothingRead, acceptable, null);

  // 한쪽 결과가 다른 쪽 평균에 섞이면 test로 재는 뜻이 없어진다.
  it('keeps the runs of each set apart', () => {
    const cases = [devCase('c01'), testCase('t01')];
    const summary = summarizeBySet(cases, [
      { id: 'c01', ...perfect },
      { id: 't01', ...blank },
    ]);
    expect(summary.map((entry) => [entry.set, entry.cases, entry.runs])).toEqual([
      ['dev', 1, 1],
      ['test', 1, 1],
    ]);
    expect(summary[0].metrics?.field_acc.mean).toBe(1);
    expect(summary[1].metrics?.field_acc.mean).toBe(blank.scores.field_acc);
    expect(summary[0].fields.age.CORRECT).toBe(1);
    expect(summary[1].fields.age.MISSED).toBe(1);
    expect(summary[0].groups.BUSINESS).toEqual({ SAME: 1, SURFACED: 0, OTHER: 0 });
    expect(summary[0].metrics?.group_changed.mean).toBe(0);
  });

  // 같은 공고의 회차는 공고 평균으로 묶는다. 구간은 공고별 평균의 표준오차 × 1.96이다(docs/domains/funding.md).
  it('averages runs per case before averaging cases', () => {
    const cases = [devCase('c01'), devCase('c02')];
    const [dev] = summarizeBySet(cases, [
      { id: 'c01', ...perfect },
      { id: 'c01', ...perfect },
      { id: 'c02', ...perfect },
      { id: 'c02', ...blank },
    ]);
    const second = (1 + blank.scores.field_acc) / 2;
    expect(dev.metrics?.field_acc.mean).toBeCloseTo((1 + second) / 2);
    const sd = Math.abs(1 - second) / Math.sqrt(2);
    expect(dev.metrics?.field_acc.half).toBeCloseTo((1.96 * sd) / Math.sqrt(2));
  });

  // 결과가 없는 set도 보인다. 0회를 0%로 보이면 안 된다.
  it('reports a set without runs as having no scores', () => {
    const summary = summarizeBySet([devCase('c01'), testCase('t01')], [{ id: 'c01', ...perfect }]);
    expect(summary[1]).toMatchObject({ set: 'test', cases: 0, runs: 0, metrics: null });
  });

  it('refuses a run of a case it was not given', () => {
    expect(() => summarizeBySet([devCase('c01')], [{ id: 't09', ...perfect }])).toThrow('t09');
  });
});
