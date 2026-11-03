import { describe, expect, it } from 'vitest';
import type { VerifiedConditions } from './condition-fields.ts';
import {
  fundingTab,
  matchCatalog,
  matchProduct,
  type ConditionMatch,
  type FundingMatchProfile,
  type MatchConditionKey,
  type ProductMatch,
} from './matching.ts';
import { fundingCatalogSchema, fundingProductSchema, type FundingCatalog, type FundingProduct } from './schema.ts';
import { AUTO_REVIEWER, FUNDING_CATALOG_SCHEMA_VERSION } from './types.ts';

// ADR 0009 §4의 맞춰 보기. 기대값의 근거는 각 테스트 옆에 적는다.
// - "ADR §4": docs/decisions/0009-funding-ai-condition-extraction.md 4절
// - "사용자 결정": 2026-11-03 5단계 질문의 답(맞아 보임은 여섯 항목 모두 맞음 + 접수 중, 마감은 출처·운영자 데이터로만 정함)
// - "기본값": 5단계 크기 제안에서 사용자에게 알리고 이의가 없던 규칙

const AS_OF = '2026-11-03';
const OFFICIAL_URL = 'https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_TEST';
const GANGNAM = '11680';
const JONGNO = '11110';

function evidence(id: string, subject: string, retrievalMethod = 'OFFICIAL_WEB_PAGE') {
  return {
    id,
    subject,
    summary: `${subject} 근거: 공식 원문에서 확인했습니다.`,
    sourceUrl: OFFICIAL_URL,
    sourceDocumentName: '테스트 공고문',
    observedAt: AS_OF,
    retrievalMethod,
    checksum: null,
  };
}

// 사람이 등록한 상품. 사업 단계·지역은 공식 원문 근거와 함께 기록돼 있다.
function manualProduct(overrides: Record<string, unknown> = {}): FundingProduct {
  return fundingProductSchema.parse({
    productKey: 'manual-loan',
    version: '1.0.0',
    name: '테스트 대출',
    organization: '테스트 기관',
    supportType: 'LOAN',
    eligibleBusinessStages: ['POST_REGISTRATION'],
    region: { scope: 'SEOUL', districtCodes: [], note: null },
    purpose: { included: [], excluded: [], note: null },
    industryConditions: { scope: 'UNKNOWN', included: [], excluded: [], note: null },
    applicationPeriod: { start: '2026-10-01', end: '2026-12-31', note: null },
    observedApplicationStatus: 'OPEN',
    observedAt: AS_OF,
    reviewedAt: AS_OF,
    nextReviewAt: '2027-01-01',
    officialUrl: OFFICIAL_URL,
    sourceDocumentName: '테스트 공고문',
    sourceDocumentRetrieved: false,
    sourceChecksum: null,
    publicLimit: '50000000',
    interestCondition: null,
    interestRateConfirmed: false,
    repaymentCondition: null,
    repaymentMethod: 'UNKNOWN',
    unsupportedCalculationReasons: ['금리가 확정되지 않았습니다.'],
    reviewer: 'operator',
    evidence: [
      evidence('identity', 'IDENTITY'),
      evidence('period', 'APPLICATION_PERIOD'),
      evidence('stage', 'BUSINESS_STAGE'),
      evidence('financial', 'FINANCIAL_CONDITION'),
      evidence('region', 'REGION'),
    ],
    ...overrides,
  });
}

// funding:sync가 모은 상품. 사업 단계·지역 필드에는 수집기의 추측이 들어 있을 수 있다.
function autoProduct(source: 'SEMAS_OLS' | 'BIZINFO', overrides: Record<string, unknown> = {}): FundingProduct {
  return manualProduct({
    productKey: source === 'SEMAS_OLS' ? 'semas-ols-agency-abc' : 'bizinfo-pbln-1',
    supportType: source === 'SEMAS_OLS' ? 'LOAN' : 'UNKNOWN',
    eligibleBusinessStages: source === 'SEMAS_OLS' ? ['POST_REGISTRATION'] : [],
    region:
      source === 'SEMAS_OLS'
        ? { scope: 'NATIONWIDE', districtCodes: [], note: null }
        : { scope: 'UNKNOWN', districtCodes: [], note: null },
    reviewer: AUTO_REVIEWER,
    nextReviewAt: null,
    evidence: [
      evidence('identity', 'IDENTITY', 'OFFICIAL_API'),
      evidence('period', 'APPLICATION_PERIOD', 'OFFICIAL_API'),
    ],
    sourceRef: { source, externalId: source === 'SEMAS_OLS' ? '대리대출:일반경영안정자금' : 'PBLN_1' },
    noticeTextChecksum: 'a'.repeat(64),
    ...overrides,
  });
}

function catalogOf(products: FundingProduct[], automation: Partial<FundingCatalog['automation']> = {}): FundingCatalog {
  return fundingCatalogSchema.parse({
    catalogKey: 'test-catalog',
    schemaVersion: FUNDING_CATALOG_SCHEMA_VERSION,
    catalogVersion: '2026-11-03.1',
    basisDate: AS_OF,
    reviewer: 'operator',
    automation: {
      policyLoanPromotion: false,
      repaymentPromotion: false,
      blockedSources: [],
      sourceSyncs: (['SEMAS_OLS', 'BIZINFO'] as const).map((source) => ({
        source,
        status: 'SUCCEEDED',
        attemptedAt: '2026-11-03T00:00:00.000Z',
        lastSucceededOn: AS_OF,
        fetchedCount: 10,
        responseChecksum: null,
        failureReason: null,
      })),
      ...automation,
    },
    products,
  });
}

const read = <T>(value: T, quote = '공고문에 적힌 조건 문장') => ({ status: 'READ' as const, value, quote });
const NOT_MENTIONED = { status: 'NOT_MENTIONED' as const };

// 여섯 조건이 모두 "제한 없음"으로 읽힌 공고. 사용자 입력이 없어도 모두 맞음이 되는 기준점이다.
function openConditions(overrides: Partial<VerifiedConditions> = {}): VerifiedConditions {
  return {
    businessStage: read('BOTH'),
    businessAge: read({ min: null, max: null, maxExclusive: false }),
    age: read({ min: null, max: null, maxExclusive: false }),
    region: read({
      scope: 'NATIONWIDE',
      provinces: [],
      districts: [],
      excludedProvinces: [],
      excludedDistricts: [],
      districtCodes: [],
      excludedDistrictCodes: [],
    }),
    foodBusiness: read('NOT_EXCLUDED'),
    targetGroups: read({ groups: [], note: null }),
    applicationPeriod: read({ start: '2026-10-01', end: '2026-12-31', text: null }),
    supportTypes: read(['LOAN']),
    ...overrides,
  } as VerifiedConditions;
}

const NO_INPUT: FundingMatchProfile = {
  businessStatus: null,
  openedYearMonth: null,
  districtCode: null,
  age: null,
  targetGroups: null,
};

function profile(overrides: Partial<FundingMatchProfile> = {}): FundingMatchProfile {
  return { ...NO_INPUT, ...overrides };
}

function match(
  product: FundingProduct,
  conditions: VerifiedConditions | null,
  user: FundingMatchProfile,
  options: { catalog?: FundingCatalog; asOfDate?: string } = {},
): ProductMatch {
  const catalog = options.catalog ?? catalogOf([product]);
  return matchProduct(product, conditions, user, {
    asOfDate: options.asOfDate ?? AS_OF,
    automation: catalog.automation,
  });
}

function condition(result: ProductMatch, key: MatchConditionKey): ConditionMatch {
  const found = result.conditions.find((entry) => entry.key === key);
  if (!found) throw new Error(`${key} 항목이 없습니다.`);
  return found;
}

function verdictOf(conditions: VerifiedConditions | null, user: FundingMatchProfile, key: MatchConditionKey) {
  const result = condition(match(autoProduct('BIZINFO'), conditions, user), key);
  return { verdict: result.verdict, checkReason: result.checkReason };
}

describe('공고 그룹(ADR §4, 사용자 결정)', () => {
  it('여섯 조건이 모두 맞고 접수 중이며 출처가 최신이면 맞아 보임이다', () => {
    const result = match(autoProduct('BIZINFO'), openConditions(), NO_INPUT);
    expect(result.conditions.map((entry) => entry.verdict)).toEqual(Array(6).fill('MATCH'));
    expect(result.group).toBe('MATCHING');
    expect(result.holds).toEqual([]);
  });

  // 사용자 결정: 언급 없음 하나라도 있으면 맞아 보임이 아니라 확인 필요다(ADR Validation "언급 없음은 확인 필요").
  it('언급 없음이 하나라도 있으면 확인 필요다', () => {
    const result = match(autoProduct('BIZINFO'), openConditions({ age: NOT_MENTIONED }), NO_INPUT);
    expect(condition(result, 'age')).toMatchObject({ verdict: 'CHECK', checkReason: 'NOT_MENTIONED' });
    expect(result.group).toBe('NEEDS_CHECK');
  });

  it('읽지 못한 항목은 확인 필요다', () => {
    const conditions = openConditions({ region: { status: 'UNREADABLE', reason: '인용이 본문에 없습니다.' } });
    const result = match(autoProduct('BIZINFO'), conditions, NO_INPUT);
    expect(condition(result, 'region')).toMatchObject({ verdict: 'CHECK', checkReason: 'UNREADABLE' });
    expect(result.group).toBe('NEEDS_CHECK');
  });

  // ADR 0009 4단계 인계: 추출 결과 행이 없으면 그 공고의 모든 항목이 읽지 못함(확인 필요)이다.
  it('추출 결과가 없는 공고는 여섯 항목이 모두 확인 필요다', () => {
    const result = match(
      autoProduct('BIZINFO'),
      null,
      profile({ businessStatus: 'PRE_STARTUP', districtCode: GANGNAM }),
    );
    expect(result.conditions.map((entry) => [entry.verdict, entry.checkReason])).toEqual(
      Array(6).fill(['CHECK', 'NOT_READ']),
    );
    expect(result.group).toBe('NEEDS_CHECK');
  });

  // ADR §4: 안 맞는 항목이 있으면 확인 필요가 남아 있어도 안 맞아 보임이다.
  it('안 맞는 항목이 하나라도 있으면 다른 항목과 상관없이 안 맞아 보임이다', () => {
    const conditions = openConditions({ foodBusiness: read('EXCLUDED'), age: NOT_MENTIONED });
    expect(match(autoProduct('BIZINFO'), conditions, NO_INPUT).group).toBe('NOT_MATCHING');
  });

  // ADR §4 "접수 중": 접수 상태를 출처에서 확인하지 못했으면 조건이 모두 맞아도 확인 필요다.
  it('조건이 모두 맞아도 접수 상태가 접수 중이 아니면 확인 필요다', () => {
    const product = autoProduct('BIZINFO', { observedApplicationStatus: 'UNKNOWN' });
    const result = match(product, openConditions(), NO_INPUT);
    expect(result.group).toBe('NEEDS_CHECK');
    expect(result.holds).toEqual(['STATUS_NOT_OPEN']);
  });

  // 기본값(ADR §6이 유지하는 3일 최신성): 출처 확인이 3일 넘게 끊기면 맞아 보임이 아니라 확인 필요다.
  it('자동 상품의 출처 확인이 3일 넘게 끊기면 확인 필요다', () => {
    const product = autoProduct('BIZINFO');
    const stale = catalogOf([product], {
      sourceSyncs: [
        {
          source: 'BIZINFO',
          status: 'FAILED',
          attemptedAt: '2026-11-03T00:00:00.000Z',
          lastSucceededOn: '2026-10-30',
          fetchedCount: 10,
          responseChecksum: null,
          failureReason: '장애',
        },
      ],
    });
    const result = match(product, openConditions(), NO_INPUT, { catalog: stale });
    expect(result.group).toBe('NEEDS_CHECK');
    expect(result.holds).toEqual(['SOURCE_STALE']);
    expect(result.automation).toMatchObject({ source: 'BIZINFO', lastSucceededOn: '2026-10-30', fresh: false });
    // 3일째까지는 최신이다(ADR 0006의 3일 규칙: 마지막 성공일 + 3일까지).
    expect(match(product, openConditions(), NO_INPUT, { catalog: stale, asOfDate: '2026-11-02' }).group).toBe(
      'MATCHING',
    );
  });

  it('사람이 등록한 상품은 출처 최신성을 보지 않는다', () => {
    const product = manualProduct();
    const result = match(product, null, NO_INPUT, { catalog: catalogOf([product], { sourceSyncs: [] }) });
    expect(result.automation).toBeNull();
    expect(result.holds).not.toContain('SOURCE_STALE');
  });
});

describe('마감(ADR §4, 사용자 결정: 마감은 출처·운영자 데이터로만, AI 종료일은 확인 필요)', () => {
  it('출처가 마감으로 표시하면 조건과 상관없이 마감이다', () => {
    const product = autoProduct('SEMAS_OLS', { observedApplicationStatus: 'CLOSED' });
    const result = match(product, openConditions({ foodBusiness: read('EXCLUDED') }), NO_INPUT);
    expect(result.group).toBe('CLOSED');
    expect(result.application.closedBy).toBe('SOURCE_STATUS');
  });

  // 종료일 당일까지는 접수 중이다(ADR 0006, funding.md 판정 규칙).
  it('출처 종료일이 지나면 마감이고 종료일 당일은 아니다', () => {
    const ended = autoProduct('BIZINFO', { applicationPeriod: { start: '2026-10-01', end: '2026-11-02', note: null } });
    expect(match(ended, openConditions(), NO_INPUT).application.closedBy).toBe('SOURCE_END_DATE');
    expect(match(ended, openConditions(), NO_INPUT).group).toBe('CLOSED');
    const today = autoProduct('BIZINFO', { applicationPeriod: { start: '2026-10-01', end: AS_OF, note: null } });
    expect(match(today, openConditions(), NO_INPUT).group).toBe('MATCHING');
  });

  // 사용자 결정(2026-11-03 단순화): AI가 읽은 값으로는 공고를 숨기지 않는다. 마감(기본으로 숨김)은 출처·운영자 데이터로만
  // 정하고, AI가 읽은 종료일이 지났으면 확인 필요로 둔다. 소진공은 다른 회차 공지의 날짜를 쓰지 않는데 AI는 그 날짜를 읽을 수 있다.
  it('AI가 읽은 종료일이 지나도 마감하지 않고 확인 필요로 둔다', () => {
    const aiEnded = openConditions({ applicationPeriod: read({ start: '2026-01-02', end: '2026-10-31', text: null }) });
    const noEnd = { start: '2026-01-02', end: null, note: '자금 소진 시까지' };
    for (const product of [
      autoProduct('SEMAS_OLS', { applicationPeriod: noEnd, observedApplicationStatus: 'UNKNOWN' }),
      autoProduct('SEMAS_OLS', { applicationPeriod: noEnd, observedApplicationStatus: 'OPEN' }),
      // 출처 종료일이 남아 있어도 AI가 더 이른 종료일을 읽었으면 확인할 거리다.
      autoProduct('SEMAS_OLS'),
    ]) {
      const result = match(product, aiEnded, NO_INPUT);
      expect(result.application.closedBy).toBeNull();
      expect(result.group).toBe('NEEDS_CHECK');
      expect(result.holds).toContain('AI_END_DATE_PASSED');
      expect(result.application.aiPeriod).toMatchObject({ status: 'READ', quote: '공고문에 적힌 조건 문장' });
    }
    // AI 종료일이 남아 있으면 보류하지 않는다.
    const aiOpen = openConditions({ applicationPeriod: read({ start: '2026-01-02', end: AS_OF, text: null }) });
    expect(match(autoProduct('SEMAS_OLS'), aiOpen, NO_INPUT).group).toBe('MATCHING');
  });
});

describe('사업 단계(ADR §4)', () => {
  it.each([
    ['BOTH', null, 'MATCH', null],
    ['BOTH', 'BUSINESS', 'MATCH', null],
    ['PRE_STARTUP_ONLY', 'PRE_STARTUP', 'MATCH', null],
    ['PRE_STARTUP_ONLY', 'BUSINESS', 'MISMATCH', null],
    ['PRE_STARTUP_ONLY', null, 'CHECK', 'INPUT_MISSING'],
    ['BUSINESS_ONLY', 'BUSINESS', 'MATCH', null],
    ['BUSINESS_ONLY', 'PRE_STARTUP', 'MISMATCH', null],
    ['BUSINESS_ONLY', null, 'CHECK', 'INPUT_MISSING'],
  ] as const)('공고 %s, 사용자 %s → %s', (stage, status, verdict, checkReason) => {
    const conditions = openConditions({ businessStage: read(stage) });
    expect(verdictOf(conditions, profile({ businessStatus: status }), 'businessStage')).toEqual({
      verdict,
      checkReason,
    });
  });
});

describe('업력(ADR §3의 하한·상한·미만, 기본값: 예비 창업자 0년, 개업 연월은 월 단위)', () => {
  const ageRange = (min: number | null, max: number | null, maxExclusive = false) =>
    openConditions({ businessAge: read({ min, max, maxExclusive }) });

  it('제한 없음이라고 밝힌 공고는 입력 없이도 맞음이다', () => {
    expect(verdictOf(ageRange(null, null), NO_INPUT, 'businessAge')).toEqual({ verdict: 'MATCH', checkReason: null });
  });

  it('사업자등록 여부나 개업 연월을 모르면 확인 필요다', () => {
    expect(verdictOf(ageRange(null, 7, true), NO_INPUT, 'businessAge')).toEqual({
      verdict: 'CHECK',
      checkReason: 'INPUT_MISSING',
    });
    expect(verdictOf(ageRange(null, 7, true), profile({ businessStatus: 'BUSINESS' }), 'businessAge')).toEqual({
      verdict: 'CHECK',
      checkReason: 'INPUT_MISSING',
    });
  });

  // 미만과 이하는 기념일 당일에만 갈린다. 2019-11-30 개업이면 2026-11-30에 7년이 된다.
  it('업력 상한의 미만·이하를 기념일 당일에 가린다', () => {
    const user = profile({ businessStatus: 'BUSINESS', openedYearMonth: '2019-11' });
    const onAnniversary = (conditions: VerifiedConditions) =>
      condition(match(autoProduct('BIZINFO'), conditions, user, { asOfDate: '2026-11-30' }), 'businessAge').verdict;
    // "7년 미만": 가장 늦은 개업일(11-30)에도 7년이 찼다.
    expect(onAnniversary(ageRange(null, 7, true))).toBe('MISMATCH');
    // "7년 이하": 11-30 개업이면 아직 이하라 개업일에 따라 갈린다.
    expect(onAnniversary(ageRange(null, 7, false))).toBe('CHECK');
  });

  it('예비 창업자는 업력 0년으로 본다', () => {
    const pre = profile({ businessStatus: 'PRE_STARTUP' });
    expect(verdictOf(ageRange(null, 7, true), pre, 'businessAge').verdict).toBe('MATCH');
    expect(verdictOf(ageRange(1, null), pre, 'businessAge').verdict).toBe('MISMATCH');
    expect(verdictOf(ageRange(0, 3), pre, 'businessAge').verdict).toBe('MATCH');
  });

  // 기준일 2026-11-03. 개업 연월만 알아서 개업일은 그달 1일~말일 중 하나다.
  it.each([
    // "3년 이상": 2023-10 개업은 어느 날이든 3년이 지났다.
    [3, null, false, '2023-10', 'MATCH', null],
    // 2023-11-01 개업이면 3년이 지났고 2023-11-30 개업이면 아직이다.
    [3, null, false, '2023-11', 'CHECK', 'UNCERTAIN'],
    [3, null, false, '2023-12', 'MISMATCH', null],
    // "7년 미만"
    [null, 7, true, '2019-12', 'MATCH', null],
    [null, 7, true, '2019-11', 'CHECK', 'UNCERTAIN'],
    [null, 7, true, '2019-10', 'MISMATCH', null],
    // "3년 이하(이내)": 2023-11-01 개업은 2026-11-01에 3년이 되어 기준일에는 넘었다.
    [null, 3, false, '2023-12', 'MATCH', null],
    [null, 3, false, '2023-11', 'CHECK', 'UNCERTAIN'],
    [null, 3, false, '2023-10', 'MISMATCH', null],
    // 이번 달 개업: 0년이다.
    [null, 1, false, '2026-11', 'MATCH', null],
  ] as const)('하한 %s, 상한 %s(미만 %s), 개업 %s → %s', (min, max, maxExclusive, opened, verdict, checkReason) => {
    const user = profile({ businessStatus: 'BUSINESS', openedYearMonth: opened });
    expect(verdictOf(ageRange(min, max, maxExclusive), user, 'businessAge')).toEqual({ verdict, checkReason });
  });
});

describe('나이(ADR §4: 만 나이, 미만·이하 구분)', () => {
  const ages = (min: number | null, max: number | null, maxExclusive = false) =>
    openConditions({ age: read({ min, max, maxExclusive }) });

  it.each([
    [null, 39, false, 39, 'MATCH'],
    [null, 39, true, 39, 'MISMATCH'],
    [null, 40, true, 39, 'MATCH'],
    [19, 39, false, 18, 'MISMATCH'],
    [19, 39, false, 19, 'MATCH'],
  ] as const)('하한 %s, 상한 %s(미만 %s), 만 %s세 → %s', (min, max, maxExclusive, age, verdict) => {
    expect(verdictOf(ages(min, max, maxExclusive), profile({ age }), 'age').verdict).toBe(verdict);
  });

  it('나이를 입력하지 않으면 확인 필요이고, 제한 없음이라고 밝힌 공고는 맞음이다', () => {
    expect(verdictOf(ages(null, 39), NO_INPUT, 'age')).toEqual({ verdict: 'CHECK', checkReason: 'INPUT_MISSING' });
    expect(verdictOf(ages(null, null), NO_INPUT, 'age')).toEqual({ verdict: 'MATCH', checkReason: null });
  });
});

describe('지역(ADR §4: 자치구는 코드로 맞춘다, 기본값: 결과가 입력에 달렸으면 미입력은 확인 필요)', () => {
  const region = (value: Record<string, unknown>) =>
    openConditions({
      region: read({
        scope: 'NATIONWIDE',
        provinces: [],
        districts: [],
        excludedProvinces: [],
        excludedDistricts: [],
        districtCodes: [],
        excludedDistrictCodes: [],
        ...value,
      }) as VerifiedConditions['region'],
    });
  const inGangnam = profile({ districtCode: GANGNAM });

  it('제외 지역 없는 전국 공고는 자치구 없이도 맞음이다', () => {
    expect(verdictOf(region({}), NO_INPUT, 'region')).toEqual({ verdict: 'MATCH', checkReason: null });
  });

  it('서울을 빼는 전국 공고는 서울 자치구 사용자에게 안 맞음이고, 자치구가 없으면 확인 필요다', () => {
    const notSeoul = region({ excludedProvinces: ['서울'] });
    expect(verdictOf(notSeoul, inGangnam, 'region').verdict).toBe('MISMATCH');
    expect(verdictOf(notSeoul, NO_INPUT, 'region')).toEqual({ verdict: 'CHECK', checkReason: 'INPUT_MISSING' });
  });

  it('시·도 한정은 서울이 들어 있어야 맞음이다', () => {
    expect(verdictOf(region({ scope: 'PROVINCES', provinces: ['서울', '경기'] }), inGangnam, 'region').verdict).toBe(
      'MATCH',
    );
    expect(verdictOf(region({ scope: 'PROVINCES', provinces: ['경기'] }), inGangnam, 'region').verdict).toBe(
      'MISMATCH',
    );
    expect(verdictOf(region({ scope: 'PROVINCES', provinces: ['서울'] }), NO_INPUT, 'region')).toEqual({
      verdict: 'CHECK',
      checkReason: 'INPUT_MISSING',
    });
  });

  it('자치구 한정과 제외 자치구는 코드로 맞춘다', () => {
    const gangnamOnly = region({ scope: 'SEOUL_DISTRICTS', provinces: ['서울'], districtCodes: [GANGNAM] });
    expect(verdictOf(gangnamOnly, inGangnam, 'region').verdict).toBe('MATCH');
    expect(verdictOf(gangnamOnly, profile({ districtCode: JONGNO }), 'region').verdict).toBe('MISMATCH');
    const seoulButGangnam = region({ scope: 'PROVINCES', provinces: ['서울'], excludedDistrictCodes: [GANGNAM] });
    expect(verdictOf(seoulButGangnam, inGangnam, 'region').verdict).toBe('MISMATCH');
    expect(verdictOf(seoulButGangnam, profile({ districtCode: JONGNO }), 'region').verdict).toBe('MATCH');
  });
});

describe('음식점·카페 제외(ADR §4: 업종은 입력받지 않는다)', () => {
  it('제외면 안 맞음, 제외 아님이면 입력 없이 맞음이다', () => {
    expect(verdictOf(openConditions({ foodBusiness: read('EXCLUDED') }), NO_INPUT, 'foodBusiness').verdict).toBe(
      'MISMATCH',
    );
    expect(verdictOf(openConditions({ foodBusiness: read('NOT_EXCLUDED') }), NO_INPUT, 'foodBusiness').verdict).toBe(
      'MATCH',
    );
  });
});

describe('대상 한정(ADR §4: 어느 것에도 해당하지 않으면 안 맞음, 입력하지 않았으면 확인 필요)', () => {
  const groups = (...list: string[]) =>
    openConditions({ targetGroups: read({ groups: list, note: null }) as VerifiedConditions['targetGroups'] });

  it('한정하지 않는다고 밝힌 공고는 입력 없이 맞음이다', () => {
    expect(verdictOf(groups(), NO_INPUT, 'targetGroups').verdict).toBe('MATCH');
  });

  it('여성 한정 공고는 해당 없음이면 안 맞음, 미입력이면 확인 필요, 여성이면 맞음이다', () => {
    expect(verdictOf(groups('WOMEN'), profile({ targetGroups: [] }), 'targetGroups').verdict).toBe('MISMATCH');
    expect(verdictOf(groups('WOMEN'), NO_INPUT, 'targetGroups')).toEqual({
      verdict: 'CHECK',
      checkReason: 'INPUT_MISSING',
    });
    expect(verdictOf(groups('WOMEN'), profile({ targetGroups: ['WOMEN'] }), 'targetGroups').verdict).toBe('MATCH');
  });

  it('여러 대상 중 하나에 해당하면 맞음이다', () => {
    expect(
      verdictOf(groups('WOMEN', 'DISABLED'), profile({ targetGroups: ['DISABLED'] }), 'targetGroups').verdict,
    ).toBe('MATCH');
  });

  // 사용자 결정(2026-11-03): 재난 피해 대상 공고는 범위 밖이라 피해 소상공인을 입력받지 않는다. 피해 소상공인으로는 해당할
  // 수 없는 것으로 보아, 피해 소상공인만 한정한 공고는 안 맞음이고 다른 대상과 함께 한정한 공고는 그 대상으로 맞춰 본다.
  it('피해 소상공인으로는 해당하지 않는 것으로 본다', () => {
    expect(verdictOf(groups('DAMAGED'), NO_INPUT, 'targetGroups').verdict).toBe('MISMATCH');
    expect(verdictOf(groups('DAMAGED', 'WOMEN'), profile({ targetGroups: [] }), 'targetGroups').verdict).toBe(
      'MISMATCH',
    );
    expect(verdictOf(groups('DAMAGED', 'WOMEN'), profile({ targetGroups: ['WOMEN'] }), 'targetGroups').verdict).toBe(
      'MATCH',
    );
    // 대상 한정을 답하지 않아도 피해 소상공인 쪽은 해당 없음이다. 남은 청년이 나이로 안 맞으면 안 맞음이다.
    const damagedOrYouth = {
      ...groups('DAMAGED', 'YOUTH'),
      age: read({ min: null, max: 39, maxExclusive: false }),
    } as VerifiedConditions;
    expect(verdictOf(damagedOrYouth, profile({ age: 45 }), 'targetGroups').verdict).toBe('MISMATCH');
  });

  it('입력으로 알 수 없는 그 밖의 대상은 확인 필요다', () => {
    expect(verdictOf(groups('OTHER'), profile({ targetGroups: [] }), 'targetGroups')).toEqual({
      verdict: 'CHECK',
      checkReason: 'UNCERTAIN',
    });
  });

  // ADR §4 "청년 한정 공고도 나이로 맞춰 본다".
  it('청년 한정은 나이 항목으로 맞춰 본다', () => {
    const youth = { ...groups('YOUTH'), age: read({ min: 19, max: 39, maxExclusive: false }) } as VerifiedConditions;
    expect(verdictOf(youth, profile({ age: 30 }), 'targetGroups').verdict).toBe('MATCH');
    expect(verdictOf(youth, profile({ age: 45 }), 'targetGroups').verdict).toBe('MISMATCH');
    expect(verdictOf(youth, NO_INPUT, 'targetGroups')).toEqual({ verdict: 'CHECK', checkReason: 'INPUT_MISSING' });
    const youthWithoutAge = { ...groups('YOUTH'), age: NOT_MENTIONED } as VerifiedConditions;
    expect(verdictOf(youthWithoutAge, profile({ age: 30 }), 'targetGroups')).toEqual({
      verdict: 'CHECK',
      checkReason: 'UNCERTAIN',
    });
  });

  // 청년 기준에는 상한이 있다. 하한만 읽혔으면("만 19세 이상 청년") 청년 기준을 읽지 못한 것이라 누구나 청년으로 보지 않는다.
  it('나이 하한만 읽힌 청년 한정은 청년인지 알 수 없다', () => {
    const lowerOnly = {
      ...groups('YOUTH'),
      age: read({ min: 19, max: null, maxExclusive: false }),
    } as VerifiedConditions;
    expect(verdictOf(lowerOnly, profile({ age: 55 }), 'targetGroups')).toEqual({
      verdict: 'CHECK',
      checkReason: 'UNCERTAIN',
    });
    const withWomen = {
      ...groups('YOUTH', 'WOMEN'),
      age: read({ min: 19, max: null, maxExclusive: false }),
    } as VerifiedConditions;
    expect(verdictOf(withWomen, profile({ age: 55, targetGroups: [] }), 'targetGroups').verdict).toBe('CHECK');
  });

  // 알려진 한계(사용자 결정 2026-11-03 단순화): 나이 항목은 대상과 묶지 않는다. "청년 또는 여성"의 나이 상한이 청년에만
  // 걸려도 나이로 안 맞음이 되고, 공고는 접어 둔 안 맞아 보임에 남아 보인다.
  it('나이 상한은 대상 한정과 상관없이 적용한다', () => {
    const conditions = {
      ...groups('YOUTH', 'WOMEN'),
      age: read({ min: null, max: 39, maxExclusive: false }),
    } as VerifiedConditions;
    const result = match(autoProduct('BIZINFO'), conditions, profile({ age: 45, targetGroups: ['WOMEN'] }));
    expect(condition(result, 'targetGroups').verdict).toBe('MATCH');
    expect(condition(result, 'age').verdict).toBe('MISMATCH');
    expect(result.group).toBe('NOT_MATCHING');
  });
});

describe('운영자 확인 값(ADR §3: catalog.json에 사람이 적은 조건이 있으면 AI 값 대신 쓴다)', () => {
  it('사람이 공식 근거와 함께 적은 사업 단계·지역을 운영자 확인으로 쓴다', () => {
    const product = manualProduct({
      eligibleBusinessStages: ['PRE_REGISTRATION'],
      region: { scope: 'DISTRICTS', districtCodes: [GANGNAM], note: null },
    });
    const result = match(product, null, profile({ businessStatus: 'PRE_STARTUP', districtCode: GANGNAM }));
    expect(condition(result, 'businessStage')).toMatchObject({
      verdict: 'MATCH',
      reading: { status: 'READ', source: 'OPERATOR', value: 'PRE_STARTUP_ONLY' },
    });
    expect(condition(result, 'businessStage').reading).toMatchObject({
      evidence: ['BUSINESS_STAGE 근거: 공식 원문에서 확인했습니다.'],
    });
    expect(condition(result, 'region')).toMatchObject({
      verdict: 'MATCH',
      reading: { status: 'READ', source: 'OPERATOR', value: { scope: 'SEOUL_DISTRICTS', districtCodes: [GANGNAM] } },
    });
    // 사람이 적지 않은 항목은 읽은 것이 없어 확인 필요다.
    expect(condition(result, 'age')).toMatchObject({ verdict: 'CHECK', checkReason: 'NOT_READ' });
  });

  it.each([
    [['PRE_REGISTRATION', 'POST_REGISTRATION'], 'BOTH'],
    [['POST_REGISTRATION'], 'BUSINESS_ONLY'],
  ] as const)('사업 단계 %j는 %s로 옮긴다', (stages, expected) => {
    const result = match(manualProduct({ eligibleBusinessStages: stages }), null, NO_INPUT);
    expect(condition(result, 'businessStage').reading).toMatchObject({ source: 'OPERATOR', value: expected });
  });

  it.each([
    [{ scope: 'NATIONWIDE', districtCodes: [], note: null }, 'NATIONWIDE', []],
    [{ scope: 'SEOUL', districtCodes: [], note: null }, 'PROVINCES', ['서울']],
  ] as const)('지역 %j는 %s로 옮긴다', (stored, scope, provinces) => {
    const result = match(manualProduct({ region: stored }), null, NO_INPUT);
    expect(condition(result, 'region').reading).toMatchObject({ source: 'OPERATOR', value: { scope, provinces } });
  });

  // 예전 판정의 규칙(직접 확인한 공식 근거가 없으면 미확인)을 잇는다. 검색 결과 요약은 원문이 아니다.
  it('공식 원문 근거가 없거나 미확인으로 적은 값은 쓰지 않는다', () => {
    const summaryOnly = manualProduct({
      evidence: [
        evidence('identity', 'IDENTITY', 'SEARCH_RESULT_SUMMARY'),
        evidence('period', 'APPLICATION_PERIOD', 'SEARCH_RESULT_SUMMARY'),
        evidence('stage', 'BUSINESS_STAGE', 'SEARCH_RESULT_SUMMARY'),
        evidence('financial', 'FINANCIAL_CONDITION', 'SEARCH_RESULT_SUMMARY'),
        evidence('region', 'REGION', 'SEARCH_RESULT_SUMMARY'),
      ],
    });
    const result = match(summaryOnly, null, NO_INPUT);
    expect(condition(result, 'businessStage')).toMatchObject({ verdict: 'CHECK', checkReason: 'NOT_READ' });
    expect(condition(result, 'region')).toMatchObject({ verdict: 'CHECK', checkReason: 'NOT_READ' });

    const unknown = manualProduct({
      eligibleBusinessStages: [],
      region: { scope: 'UNKNOWN', districtCodes: [], note: null },
    });
    expect(condition(match(unknown, null, NO_INPUT), 'businessStage').checkReason).toBe('NOT_READ');
    expect(condition(match(unknown, null, NO_INPUT), 'region').checkReason).toBe('NOT_READ');
  });

  it('사람 기록이 있으면 같은 항목의 AI 값 대신 쓰고, 나머지 항목은 AI 값을 쓴다', () => {
    const product = manualProduct({ eligibleBusinessStages: ['POST_REGISTRATION'] });
    const conditions = openConditions({
      businessStage: read('BOTH'),
      age: read({ min: null, max: 39, maxExclusive: false }),
    });
    const result = match(product, conditions, profile({ businessStatus: 'PRE_STARTUP', age: 30 }));
    expect(condition(result, 'businessStage')).toMatchObject({ verdict: 'MISMATCH', reading: { source: 'OPERATOR' } });
    expect(condition(result, 'age')).toMatchObject({ verdict: 'MATCH', reading: { source: 'AI' } });
  });

  // 자동 상품의 사업 단계·지역 필드는 수집기의 추측이다(ADR 0009 Context). 운영자 확인으로 쓰지 않는다.
  it('자동 상품의 사업 단계·지역 필드는 쓰지 않고 AI가 읽은 값만 쓴다', () => {
    const semas = autoProduct('SEMAS_OLS', {
      evidence: [
        evidence('identity', 'IDENTITY'),
        evidence('period', 'APPLICATION_PERIOD'),
        evidence('stage', 'BUSINESS_STAGE'),
        evidence('financial', 'FINANCIAL_CONDITION'),
      ],
    });
    const result = match(semas, null, profile({ businessStatus: 'PRE_STARTUP', districtCode: GANGNAM }));
    expect(condition(result, 'businessStage')).toMatchObject({ verdict: 'CHECK', checkReason: 'NOT_READ' });
    expect(condition(result, 'region')).toMatchObject({ verdict: 'CHECK', checkReason: 'NOT_READ' });
  });
});

describe('갈래(ADR §1: 출처와 출처의 지원분야로만 정한다)', () => {
  it.each([
    ['소진공 자금', () => autoProduct('SEMAS_OLS'), 'POLICY_FUND'],
    ['기업마당 금융', () => autoProduct('BIZINFO', { sourceCategory: '금융' }), 'POLICY_FUND'],
    ['기업마당 창업', () => autoProduct('BIZINFO', { sourceCategory: '창업' }), 'SUPPORT_PROGRAM'],
    ['기업마당 분야 없음', () => autoProduct('BIZINFO'), 'SUPPORT_PROGRAM'],
    ['사람 등록 대출', () => manualProduct({ supportType: 'LOAN' }), 'POLICY_FUND'],
    ['사람 등록 보증', () => manualProduct({ supportType: 'GUARANTEE' }), 'POLICY_FUND'],
    [
      '사람 등록 지원금',
      () => manualProduct({ supportType: 'GRANT', repaymentMethod: 'NOT_APPLICABLE' }),
      'SUPPORT_PROGRAM',
    ],
    [
      '사람 등록 공간',
      () => manualProduct({ supportType: 'SPACE', repaymentMethod: 'NOT_APPLICABLE' }),
      'SUPPORT_PROGRAM',
    ],
  ] as const)('%s → %s', (_label, build, tab) => {
    expect(fundingTab(build())).toBe(tab);
  });
});

describe('카탈로그 전체 맞춰 보기', () => {
  it('차단 목록의 자동 상품은 보여 주지 않는다(ADR §6 운영자 숨김)', () => {
    const blocked = autoProduct('BIZINFO');
    const shown = autoProduct('SEMAS_OLS');
    const catalog = catalogOf([blocked, shown], {
      blockedSources: [{ source: 'BIZINFO', externalId: 'PBLN_1', reason: '운영자 숨김' }],
    });
    const list = matchCatalog(catalog, new Map(), NO_INPUT, { asOfDate: AS_OF });
    const keys = [...list.tabs.POLICY_FUND.products, ...list.tabs.SUPPORT_PROGRAM.products].map((p) => p.productKey);
    expect(keys).toEqual(['semas-ols-agency-abc']);
    // 화면은 릴리스 상품 수와 보여 준 수의 차이를 운영자 숨김으로 밝힌다.
    expect(list.hiddenCount).toBe(1);
  });

  it('운영자 지역 메모는 사람이 등록한 상품에서만 넘긴다', () => {
    // 자동 상품의 지역 필드는 수집기의 추측이라 쓰지 않는다(ADR 0009 Context·§7). 그 메모도 보여 주지 않는다.
    const manual = manualProduct({ region: { scope: 'SEOUL', districtCodes: [], note: '서울 소재 사업장' } });
    const auto = autoProduct('BIZINFO', {
      region: { scope: 'UNKNOWN', districtCodes: [], note: '기업마당 공고에서 대상 지역을 확인하지 못했습니다.' },
    });
    const list = matchCatalog(catalogOf([manual, auto]), new Map(), NO_INPUT, { asOfDate: AS_OF });
    expect(list.hiddenCount).toBe(0);
    expect(list.tabs.POLICY_FUND.products[0]?.operatorRegionNote).toBe('서울 소재 사업장');
    expect(list.tabs.SUPPORT_PROGRAM.products[0]?.operatorRegionNote).toBeNull();
  });

  // 사용자 결정(2026-11-03 단순화): AI가 읽은 값으로는 공고를 숨기지 않는다. 피해 소상공인만 한정했다고 읽은 공고도 접어 둔
  // 안 맞아 보임에 남는다. 잘못 읽혀도(예: 경영애로 자금) 사라지지 않는다.
  it('피해 소상공인만 한정한 공고는 숨기지 않고 안 맞아 보임에 둔다', () => {
    const disasterOnly = autoProduct('BIZINFO', {
      productKey: 'bizinfo-disaster',
      sourceRef: { source: 'BIZINFO', externalId: 'DISASTER' },
    });
    const conditions = openConditions({
      targetGroups: read({ groups: ['DAMAGED'], note: null }) as VerifiedConditions['targetGroups'],
    });
    const list = matchCatalog(catalogOf([disasterOnly]), new Map([['bizinfo-disaster', conditions]]), NO_INPUT, {
      asOfDate: AS_OF,
    });
    expect(list.tabs.SUPPORT_PROGRAM.products.map((p) => [p.productKey, p.group])).toEqual([
      ['bizinfo-disaster', 'NOT_MATCHING'],
    ]);
  });

  it('갈래마다 그룹 순서(맞아 보임 → 확인 필요 → 안 맞아 보임 → 마감)로 놓고 그룹별 수를 센다', () => {
    const matching = autoProduct('BIZINFO', {
      productKey: 'bizinfo-a',
      sourceRef: { source: 'BIZINFO', externalId: 'A' },
    });
    const closed = autoProduct('BIZINFO', {
      productKey: 'bizinfo-b',
      sourceRef: { source: 'BIZINFO', externalId: 'B' },
      observedApplicationStatus: 'CLOSED',
    });
    const mismatch = autoProduct('BIZINFO', {
      productKey: 'bizinfo-c',
      sourceRef: { source: 'BIZINFO', externalId: 'C' },
    });
    const check = autoProduct('BIZINFO', {
      productKey: 'bizinfo-d',
      sourceRef: { source: 'BIZINFO', externalId: 'D' },
    });
    const catalog = catalogOf([closed, mismatch, check, matching]);
    const extractions = new Map<string, VerifiedConditions>([
      ['bizinfo-a', openConditions()],
      ['bizinfo-b', openConditions()],
      ['bizinfo-c', openConditions({ foodBusiness: read('EXCLUDED') })],
      ['bizinfo-d', openConditions({ age: NOT_MENTIONED })],
    ]);
    const list = matchCatalog(catalog, extractions, NO_INPUT, { asOfDate: AS_OF });
    expect(list.tabs.SUPPORT_PROGRAM.products.map((p) => [p.productKey, p.group])).toEqual([
      ['bizinfo-a', 'MATCHING'],
      ['bizinfo-d', 'NEEDS_CHECK'],
      ['bizinfo-c', 'NOT_MATCHING'],
      ['bizinfo-b', 'CLOSED'],
    ]);
    expect(list.tabs.SUPPORT_PROGRAM.counts).toEqual({ MATCHING: 1, NEEDS_CHECK: 1, NOT_MATCHING: 1, CLOSED: 1 });
    expect(list.tabs.POLICY_FUND.counts).toEqual({ MATCHING: 0, NEEDS_CHECK: 0, NOT_MATCHING: 0, CLOSED: 0 });
  });

  // 지금 본문이 없는 상품(본문을 읽지 못함)에는 같은 키로 넘어온 결과가 있어도 붙이지 않는다.
  it('본문 checksum이 없는 상품은 추출 결과를 쓰지 않는다', () => {
    const product = autoProduct('BIZINFO', { noticeTextChecksum: undefined });
    const list = matchCatalog(catalogOf([product]), new Map([[product.productKey, openConditions()]]), NO_INPUT, {
      asOfDate: AS_OF,
    });
    const [only] = list.tabs.SUPPORT_PROGRAM.products;
    expect(only.conditions.map((entry) => entry.checkReason)).toEqual(Array(6).fill('NOT_READ'));
  });

  // ADR §4 정책자금 탭: 한도 문장을 보여 준다. 소진공은 대출한도 칸, 사람 등록 상품은 공개 한도다.
  it('정책자금 카드에 출처의 한도 문장과 공개 한도를 함께 담는다', () => {
    const semas = autoProduct('SEMAS_OLS', { limitText: '7천만원', publicLimit: '70000000' });
    const result = match(semas, null, NO_INPUT);
    expect(result.limit).toEqual({ publicLimitKrw: '70000000', limitText: '7천만원' });
  });
});
