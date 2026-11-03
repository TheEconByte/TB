import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ConditionValues } from './condition-fields.ts';
import {
  AI_READING_NOTICE,
  LIMIT_NOTE,
  aiPeriodText,
  applicationPeriodText,
  checkReasonText,
  closedText,
  conditionValueText,
  fundingGapText,
  fundingProfileSummary,
  holdText,
  limitText,
  rangeText,
} from './match-text.ts';
import {
  MATCH_CONDITION_KEYS,
  type CheckReason,
  type ConditionMatch,
  type FundingMatchProfile,
  type MatchHold,
  type ProductMatch,
} from './matching.ts';

// 맞춰 보기 화면의 문장(ADR 0009 §4). 판정 코드(hold·checkReason·closedBy)를 사람이 읽는 문장으로 바꾼다.
// PRODUCT.md 원칙 5: 맞아 보여도 신청 자격이나 결정이 확정된 것처럼 쓰지 않는다.
const FORBIDDEN = ['신청 가능', '승인'];

function product(overrides: Partial<ProductMatch> = {}): ProductMatch {
  return {
    productKey: 'bizinfo-pbln-1',
    version: '1.0.0',
    name: '테스트 공고',
    organization: '테스트 기관',
    supportType: 'UNKNOWN',
    tab: 'SUPPORT_PROGRAM',
    group: 'NEEDS_CHECK',
    officialUrl: 'https://www.bizinfo.go.kr/x',
    automation: { source: 'BIZINFO', sourceLabel: '기업마당', lastSucceededOn: '2026-10-28', fresh: false },
    application: {
      status: 'UNKNOWN',
      period: { start: null, end: '2026-10-31', note: null },
      aiPeriod: {
        status: 'READ',
        source: 'AI',
        value: { start: '2026-10-01', end: '2026-10-20', text: null },
        quote: '접수기간: 2026. 10. 1. ~ 10. 20.',
      },
      closedBy: null,
    },
    holds: [],
    conditions: [],
    supportTypes: { status: 'NOT_MENTIONED' },
    limit: { publicLimitKrw: null, limitText: null },
    operatorRegionNote: null,
    ...overrides,
  };
}

const range = (min: number | null, max: number | null, maxExclusive = false) => ({ min, max, maxExclusive });

describe('범위 문장', () => {
  // ConditionRange: null인 쪽은 제한 없음, maxExclusive면 미만(condition-fields.ts).
  it('나이 범위', () => {
    expect(rangeText('age', range(19, 39))).toBe('만 19세 이상 39세 이하');
    expect(rangeText('age', range(null, 39, true))).toBe('만 39세 미만');
    expect(rangeText('age', range(19, null))).toBe('만 19세 이상');
    expect(rangeText('age', range(null, null))).toBe('나이 제한 없음');
  });

  it('업력 범위', () => {
    expect(rangeText('businessAge', range(null, 7, true))).toBe('업력 7년 미만');
    expect(rangeText('businessAge', range(3, null))).toBe('업력 3년 이상');
    expect(rangeText('businessAge', range(1, 5))).toBe('업력 1년 이상 5년 이하');
    expect(rangeText('businessAge', range(null, null))).toBe('업력 제한 없음');
  });
});

describe('읽은 값 문장', () => {
  const read = <K extends ConditionMatch['key']>(key: K, value: ConditionValues[K]) =>
    ({
      key,
      reading: { status: 'READ', source: 'AI', value, quote: '원문' },
      verdict: 'MATCH',
      checkReason: null,
    }) as ConditionMatch;

  it('항목마다 값을 문장으로 쓴다', () => {
    expect(conditionValueText(read('businessStage', 'PRE_STARTUP_ONLY'))).toBe('예비 창업자만');
    expect(conditionValueText(read('businessStage', 'BOTH'))).toBe('예비 창업자·사업자 모두');
    expect(conditionValueText(read('foodBusiness', 'EXCLUDED'))).toContain('음식점·카페');
    expect(
      conditionValueText(
        read('region', {
          scope: 'SEOUL_DISTRICTS',
          provinces: ['서울'],
          districts: ['마포구', '용산구'],
          excludedProvinces: [],
          excludedDistricts: [],
          districtCodes: ['11440', '11170'],
          excludedDistrictCodes: [],
        }),
      ),
    ).toBe('서울 마포구·용산구');
    expect(
      conditionValueText(
        read('region', {
          scope: 'NATIONWIDE',
          provinces: [],
          districts: [],
          excludedProvinces: ['서울'],
          excludedDistricts: [],
          districtCodes: [],
          excludedDistrictCodes: [],
        }),
      ),
    ).toBe('전국 (제외: 서울)');
    expect(conditionValueText(read('targetGroups', { groups: [], note: null }))).toBe('대상 한정 없음');
    expect(conditionValueText(read('targetGroups', { groups: ['YOUTH', 'OTHER'], note: '북한이탈주민' }))).toBe(
      '청년 · 그 밖의 대상(북한이탈주민)',
    );
  });

  it('읽지 않은 항목은 값 문장이 없다', () => {
    const condition = {
      key: 'age',
      reading: { status: 'NOT_MENTIONED' },
      verdict: 'CHECK',
      checkReason: 'NOT_MENTIONED',
    } as ConditionMatch;
    expect(conditionValueText(condition)).toBeNull();
  });
});

describe('확인 필요 이유 문장', () => {
  const checked = (key: ConditionMatch['key'], checkReason: CheckReason, reading?: ConditionMatch['reading']) =>
    ({
      key,
      reading: reading ?? { status: 'READ', source: 'AI', value: range(19, 39), quote: '원문' },
      verdict: 'CHECK',
      checkReason,
    }) as ConditionMatch;

  it('맞음·안 맞음에는 이유 문장이 없다', () => {
    expect(checkReasonText({ ...checked('age', 'INPUT_MISSING'), verdict: 'MATCH', checkReason: null })).toBeNull();
  });

  it('읽지 못한 이유를 그대로 보여 준다', () => {
    const text = checkReasonText(
      checked('age', 'UNREADABLE', { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' }),
    );
    expect(text).toContain('인용이 본문에 없습니다.');
  });

  it('입력이 없으면 무엇을 입력하면 되는지 쓴다', () => {
    expect(checkReasonText(checked('age', 'INPUT_MISSING'))).toContain('나이');
    expect(checkReasonText(checked('region', 'INPUT_MISSING'))).toContain('자치구');
    expect(checkReasonText(checked('businessAge', 'INPUT_MISSING'))).toContain('개업 연월');
    expect(checkReasonText(checked('businessStage', 'INPUT_MISSING'))).toContain('사업자등록 여부');
    expect(checkReasonText(checked('targetGroups', 'INPUT_MISSING'))).toContain('대상 한정');
  });

  it('모든 이유에 문장이 있다', () => {
    const reasons: CheckReason[] = ['NOT_MENTIONED', 'UNREADABLE', 'NOT_READ', 'INPUT_MISSING', 'UNCERTAIN'];
    for (const key of MATCH_CONDITION_KEYS) {
      for (const reason of reasons) {
        const reading =
          reason === 'UNREADABLE'
            ? ({ status: 'UNREADABLE', reason: '값이 말이 안 됩니다.' } as const)
            : reason === 'NOT_MENTIONED'
              ? ({ status: 'NOT_MENTIONED' } as const)
              : reason === 'NOT_READ'
                ? ({ status: 'NOT_READ' } as const)
                : undefined;
        expect(checkReasonText(checked(key, reason, reading))?.length ?? 0, `${key} ${reason}`).toBeGreaterThan(10);
      }
    }
  });
});

describe('보류와 마감 문장', () => {
  it('접수 상태를 출처에서 확인하지 못했음을 쓴다', () => {
    expect(holdText('STATUS_NOT_OPEN', product())).toContain('접수');
  });

  it('출처 확인이 끊겼으면 출처와 마지막 확인일을 쓴다', () => {
    const text = holdText('SOURCE_STALE', product());
    expect(text).toContain('기업마당');
    expect(text).toContain('2026. 10. 28.');
  });

  it('AI가 읽은 종료일이 지났으면 그 날짜와 숨기지 않은 이유를 쓴다', () => {
    const text = holdText('AI_END_DATE_PASSED', product());
    expect(text).toContain('2026. 10. 20.');
    expect(text).toContain('AI');
    expect(text).toContain('마감으로 숨기지 않았습니다');
  });

  it('마감은 출처·운영자 근거를 쓴다', () => {
    expect(closedText(product())).toBeNull();
    const byStatus = product({ application: { ...product().application, closedBy: 'SOURCE_STATUS' } });
    expect(closedText(byStatus)).toContain('접수 마감');
    const byDate = product({ application: { ...product().application, closedBy: 'SOURCE_END_DATE' } });
    expect(closedText(byDate)).toContain('2026. 10. 31.');
  });
});

describe('신청기간 문장', () => {
  it('한쪽 날짜만 있으면 빈 쪽을 기록 없음으로 쓰지 않는다', () => {
    expect(applicationPeriodText({ start: '2026-10-01', end: null, note: '예산 소진 시까지' })).toBe(
      '2026. 10. 1. ~ (예산 소진 시까지)',
    );
    expect(applicationPeriodText({ start: '2026-10-01', end: '2026-12-31', note: null })).toBe(
      '2026. 10. 1. ~ 2026. 12. 31.',
    );
    expect(applicationPeriodText({ start: null, end: null, note: null })).toBe('기록 없음');
    expect(aiPeriodText({ start: null, end: '2026-10-15', text: null })).toBe('~ 2026. 10. 15.');
  });
});

describe('한도와 부족자금 문장', () => {
  it('출처의 한도 문장을 우선하고, 없으면 공개 한도를 쓴다', () => {
    expect(limitText({ publicLimitKrw: '70000000', limitText: '업체당 최대 7천만원' })).toContain(
      '업체당 최대 7천만원',
    );
    expect(limitText({ publicLimitKrw: '50000000', limitText: null })).toContain('50,000,000원');
    expect(limitText({ publicLimitKrw: null, limitText: null })).toContain('확인하지 못했습니다');
  });

  it('한도는 최대치이고 실제 금액은 심사로 정해진다고 쓴다', () => {
    // ADR 0009 §4 정책자금 탭.
    expect(LIMIT_NOTE).toContain('최대치');
    expect(LIMIT_NOTE).toContain('심사');
  });

  it('보고 있는 저장 결과의 부족자금을 revision과 함께 쓴다', () => {
    const text = fundingGapText({ revision: 3, value: { status: 'READY', value: '50000000' } });
    expect(text).toContain('revision 3');
    expect(text).toContain('50,000,000원');
    expect(
      fundingGapText({ revision: 2, value: { status: 'INSUFFICIENT_INPUT', value: null, missingFields: ['equity'] } }),
    ).toContain('계산하지 못했습니다');
    // 저장 결과를 보고 있지 않으면 다시 계산해 채우지 않는다(계산 결과는 저장된 것만 쓴다).
    expect(fundingGapText(null)).not.toMatch(/\d원/);
  });
});

describe('입력 요약', () => {
  const NO_INPUT: FundingMatchProfile = {
    businessStatus: null,
    openedYearMonth: null,
    districtCode: null,
    age: null,
    targetGroups: null,
  };

  it('입력하지 않은 항목과 해당 없음을 구분해 쓴다', () => {
    expect(fundingProfileSummary(NO_INPUT, null)).toBe(
      '사업자등록 여부 미입력 · 자치구 미입력 · 나이 미입력 · 대상 한정 답하지 않음',
    );
    expect(fundingProfileSummary({ ...NO_INPUT, targetGroups: [] }, null)).toContain('대상 한정 해당 없음');
  });

  it('사업 조건에서 가져온 자치구는 그렇다고 밝힌다', () => {
    const summary = fundingProfileSummary(
      {
        businessStatus: 'BUSINESS',
        openedYearMonth: '2024-03',
        districtCode: '11200',
        age: 35,
        targetGroups: ['WOMEN'],
      },
      'BUSINESS_PROFILE',
    );
    expect(summary).toBe('사업자(개업 2024년 3월) · 성동구(사업 조건의 자치구) · 만 35세 · 대상 한정 여성');
  });
});

describe('쓰지 않는 문구', () => {
  it('화면 문장 어디에도 신청 자격이나 결정을 확정하는 문구가 없다', () => {
    const texts = [
      AI_READING_NOTICE,
      LIMIT_NOTE,
      ...(['STATUS_NOT_OPEN', 'SOURCE_STALE', 'AI_END_DATE_PASSED'] as MatchHold[]).map((hold) =>
        holdText(hold, product()),
      ),
      closedText(product({ application: { ...product().application, closedBy: 'SOURCE_STATUS' } })) ?? '',
      limitText({ publicLimitKrw: '1', limitText: null }),
      fundingGapText(null),
    ];
    for (const text of texts) for (const word of FORBIDDEN) expect(text, text).not.toContain(word);
  });

  it('맞춰 보기 화면 파일에 그런 문구를 쓰지 않는다', () => {
    // 렌더링하지 않는 분기까지 보려고 소스를 읽는다. 주석에도 쓰지 않는다.
    const files = [
      'match-text.ts',
      'FundingMatchesPanel.tsx',
      'FundingProfileFields.tsx',
      'FundingMatcher.tsx',
      // 계획 화면의 자금 패널.
      '../plans/TrendBenchApp.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      for (const word of FORBIDDEN) expect(source.includes(word), `${file}: ${word}`).toBe(false);
    }
  });
});

describe('AI 안내 문구', () => {
  it('ADR 0009 §4의 문구 그대로다', () => {
    expect(AI_READING_NOTICE).toBe('AI가 공고문에서 읽은 내용입니다. 신청 전 원 공고를 확인하세요');
  });
});
