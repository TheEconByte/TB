import {
  CONDITION_FIELD_NAMES,
  type ConditionFieldName,
  type ConditionRange,
  type ConditionTargetGroup,
  type ConditionValues,
  type VerifiedConditions,
  type VerifiedField,
} from './condition-fields.ts';
import { SEOUL_DISTRICTS } from './districts.ts';
import { sourceRefKey, type FundingAutomation, type FundingCatalog, type FundingProduct } from './schema.ts';
import {
  FUNDING_SOURCE_LABELS,
  POLICY_LOAN_SUPPORT_TYPES,
  compareIsoDates,
  isPrimaryRetrievalMethod,
  isSourceFresh,
  type EvidenceSubject,
  type FundingSource,
  type ObservedApplicationStatus,
  type SupportType,
} from './types.ts';

// 공고에서 읽은 조건과 사용자 입력을 맞춰 본다(ADR 0009 §4). React·DB·외부 API에 의존하지 않는다.
// AI가 읽은 값으로는 공고를 숨기지 않는다. AI 값은 항목별 맞음·안 맞음·확인 필요만 정하고(안 맞음은 접어 두되 보인다), 기본으로
// 숨기는 마감은 출처·운영자 데이터로만 정한다(사용자 결정 2026-11-03).
// 마감이 아닌 공고의 그룹은 항목의 판정으로만 정하고, 접수 상태는 그룹과 따로 넘긴다(사용자 결정 2026-11-13).
// 사용자 입력은 AI에 보내지 않는다. 이 파일은 AI 클라이언트에 닿지 않는다(notice-extraction.test.ts가 확인한다).

// 사용자가 고르는 대상 한정. 청년은 나이로 맞춰 보므로 고르지 않는다(ADR §4). 재난 피해 대상 공고는 범위 밖이라 피해
// 소상공인은 고르지 않는다(사용자 결정 2026-11-03).
export const USER_TARGET_GROUPS = ['WOMEN', 'DISABLED', 'RESTART'] as const;
export type UserTargetGroup = (typeof USER_TARGET_GROUPS)[number];

// 맞춰 보기에 쓰는 사용자 입력. null은 입력하지 않음이다. 값의 형식은 호출하는 쪽이 검증해 넘긴다: 개업 연월은 실제 달
// (YYYY-MM, 01~12), 나이는 0 이상의 정수, 자치구는 서울 자치구 코드(districts.ts). 이 함수는 형식을 다시 검사하지 않는다.
export type FundingMatchProfile = {
  businessStatus: 'PRE_STARTUP' | 'BUSINESS' | null;
  // 사업자의 개업 연월(YYYY-MM). 예비 창업자면 쓰지 않는다.
  openedYearMonth: string | null;
  // 자금 조건의 자치구, 비어 있으면 계획 사업 프로필의 자치구. 호출하는 쪽이 정해 넘긴다.
  districtCode: string | null;
  // 대표자 만 나이.
  age: number | null;
  // null은 답하지 않음, 빈 목록은 해당 없음이다. 장애 여부는 민감한 답이라 맞춰 보기에만 쓴다(ADR Consequences).
  targetGroups: UserTargetGroup[] | null;
};

// 맞춰 보는 조건. 신청기간은 마감에, 지원 방식은 표시에만 쓴다.
export const MATCH_CONDITION_KEYS = [
  'businessStage',
  'businessAge',
  'age',
  'region',
  'foodBusiness',
  'targetGroups',
] as const satisfies readonly ConditionFieldName[];
export type MatchConditionKey = (typeof MATCH_CONDITION_KEYS)[number];

export type MatchVerdict = 'MATCH' | 'MISMATCH' | 'CHECK';
// 확인 필요의 이유. NOT_READ는 추출 결과가 없거나(읽지 않음·실패) 운영자 기록도 없는 경우다. UNCERTAIN은 값을 읽었고
// 입력도 있지만 그것만으로 정할 수 없는 경우다(개업 연월의 날짜, 입력으로 알 수 없는 대상 등).
// TITLE_REGION_MARK는 지역이 언급 없음인데 기업마당 공고 제목 맨 앞에 서울도 전국도 아닌 [..] 표시가 있는 경우다(ADR §4).
export type CheckReason =
  'NOT_MENTIONED' | 'UNREADABLE' | 'NOT_READ' | 'INPUT_MISSING' | 'UNCERTAIN' | 'TITLE_REGION_MARK';

// 조건을 어디서 읽었는지. 운영자 확인은 catalog.json에 사람이 적은 값이며 인용 대신 근거 요약이 있다(ADR §3).
export type ConditionReading<T> =
  | { status: 'READ'; source: 'AI'; value: T; quote: string }
  | { status: 'READ'; source: 'OPERATOR'; value: T; evidence: string[] }
  | { status: 'NOT_MENTIONED' }
  | { status: 'UNREADABLE'; reason: string }
  | { status: 'NOT_READ' };

type Readings = { [K in ConditionFieldName]: ConditionReading<ConditionValues[K]> };

export type ConditionMatch = {
  [K in MatchConditionKey]: {
    key: K;
    reading: ConditionReading<ConditionValues[K]>;
    verdict: MatchVerdict;
    checkReason: CheckReason | null;
  };
}[MatchConditionKey];

// 화면에 놓는 순서다(ADR §4). 마감이 아니면 여섯 항목의 판정으로만 정한다. 안 맞음이 하나라도 있으면 안 맞아 보임, 모두
// 맞음이면 맞아 보임, 맞음이 아닌 항목이 모두 공고문에 언급 없음이면 걸리는 조건 안 보임(NOT_MENTIONED_ONLY), 나머지는
// 확인 필요다. 지역이 언급 없음이어도 제목에 다른 지역 표시가 있으면 이유가 제목 표시라서 나머지에 든다(withTitleRegionMark).
// 언급 없음은 제한 없음이 아니라서(ADR §3) 맞아 보임과 섞지 않는다.
export const FUNDING_MATCH_GROUPS = [
  'MATCHING',
  'NOT_MENTIONED_ONLY',
  'NEEDS_CHECK',
  'NOT_MATCHING',
  'CLOSED',
] as const;
export type FundingMatchGroup = (typeof FUNDING_MATCH_GROUPS)[number];

// 갈래(ADR §1). 출처와 출처의 지원분야로만 정한다.
export const FUNDING_TABS = ['POLICY_FUND', 'SUPPORT_PROGRAM'] as const;
export type FundingTab = (typeof FUNDING_TABS)[number];

// 마감이 아닌 공고를 접수 중으로 확인하지 못한 이유. 출처·운영자의 접수 상태가 접수 중이 아님, 출처 확인이 끊김(3일 최신성,
// ADR §6이 유지), AI가 읽은 신청 종료일이 지남(마감으로 숨기지 않는다). 그룹은 바꾸지 않는다.
export type OpenUnconfirmedReason = 'STATUS_NOT_OPEN' | 'SOURCE_STALE' | 'AI_END_DATE_PASSED';
// 마감의 근거. 출처·운영자의 접수 상태와 신청 종료일만 쓴다.
export type ClosedBy = 'SOURCE_STATUS' | 'SOURCE_END_DATE';
// 카드에 그룹과 따로 보여 주는 접수 상태(ADR §4).
export type ApplicationState = 'OPEN_CONFIRMED' | 'UNCONFIRMED' | 'CLOSED';

export type ProductMatch = {
  productKey: string;
  version: string;
  name: string;
  organization: string;
  supportType: SupportType;
  tab: FundingTab;
  group: FundingMatchGroup;
  officialUrl: string;
  // 자동으로 모은 상품의 출처와 마지막 성공 확인일. 사람이 등록한 상품은 null이다.
  automation: { source: FundingSource; sourceLabel: string; lastSucceededOn: string | null; fresh: boolean } | null;
  application: {
    status: ObservedApplicationStatus;
    period: FundingProduct['applicationPeriod'];
    aiPeriod: ConditionReading<ConditionValues['applicationPeriod']>;
    closedBy: ClosedBy | null;
    // 마감이 아니고 비어 있으면 접수 중으로 확인한 공고다. 마감이면 비어 있다.
    unconfirmedReasons: OpenUnconfirmedReason[];
  };
  conditions: ConditionMatch[];
  supportTypes: ConditionReading<ConditionValues['supportTypes']>;
  // 정책자금 카드의 한도. 공개 한도는 최대치이며 실제 금액은 심사로 정해진다(ADR §4).
  limit: { publicLimitKrw: string | null; limitText: string | null };
  // 사람이 등록한 상품에 운영자가 적은 지역 메모. 자동 상품의 지역 필드는 수집기의 추측이라 null이다.
  operatorRegionNote: string | null;
  // 사람이 등록한 상품의 기록일. 사람 상품은 출처 최신성을 따지지 않으므로 언제 기록한 내용인지 보여 준다.
  // 그룹에는 쓰지 않는다. 자동 상품은 null이다.
  operatorRecord: { observedAt: string } | null;
  // 기업마당 공고 제목 맨 앞의 [..] 표시. 지역 항목의 확인 필요 이유를 문장으로 쓸 때 보여 준다. 없으면 null이다.
  titleRegionMark: string | null;
};

export type FundingMatchList = {
  asOfDate: string;
  // 차단 목록이라 보여 주지 않은 자동 상품 수(ADR §6 운영자 숨김). 릴리스 상품 수와 보여 준 수의 차이를 밝힌다.
  hiddenCount: number;
  tabs: Record<FundingTab, { counts: Record<FundingMatchGroup, number>; products: ProductMatch[] }>;
};

// 기업마당 지원분야 중 정책자금 갈래로 보는 값(ADR §1).
const BIZINFO_FINANCE_CATEGORY = '금융';

export function fundingTab(product: FundingProduct): FundingTab {
  if (product.origin === 'SYNC') {
    if (product.sourceRef?.source === 'SEMAS_OLS') return 'POLICY_FUND';
    if (product.sourceRef?.source === 'BIZINFO' && product.sourceCategory === BIZINFO_FINANCE_CATEGORY)
      return 'POLICY_FUND';
    return 'SUPPORT_PROGRAM';
  }
  return POLICY_LOAN_SUPPORT_TYPES.includes(product.supportType) ? 'POLICY_FUND' : 'SUPPORT_PROGRAM';
}

function fromExtraction<T>(field: VerifiedField<T> | undefined): ConditionReading<T> {
  if (field === undefined) return { status: 'NOT_READ' };
  if (field.status === 'READ') return { status: 'READ', source: 'AI', value: field.value, quote: field.quote };
  return field;
}

// 사람이 공식 원문에서 직접 확인한 근거. 검색 결과 요약만 있으면 확인한 값으로 보지 않는다.
function operatorEvidence(product: FundingProduct, subject: EvidenceSubject): string[] | null {
  const summaries = product.evidence
    .filter((entry) => entry.subject === subject && isPrimaryRetrievalMethod(entry.retrievalMethod))
    .map((entry) => entry.summary);
  return summaries.length > 0 ? summaries : null;
}

function operatorStage(product: FundingProduct): ConditionValues['businessStage'] | null {
  const stages = new Set(product.eligibleBusinessStages);
  if (stages.has('PRE_REGISTRATION') && stages.has('POST_REGISTRATION')) return 'BOTH';
  if (stages.has('PRE_REGISTRATION')) return 'PRE_STARTUP_ONLY';
  if (stages.has('POST_REGISTRATION')) return 'BUSINESS_ONLY';
  return null;
}

const DISTRICT_NAMES = new Map(SEOUL_DISTRICTS.map((district) => [district.code, district.name]));

function operatorRegion(product: FundingProduct): ConditionValues['region'] | null {
  const base = {
    provinces: [] as string[],
    districts: [] as string[],
    excludedProvinces: [] as string[],
    excludedDistricts: [] as string[],
    districtCodes: [] as string[],
    excludedDistrictCodes: [] as string[],
  };
  switch (product.region.scope) {
    case 'NATIONWIDE':
      return { ...base, scope: 'NATIONWIDE' };
    case 'SEOUL':
      return { ...base, scope: 'PROVINCES', provinces: ['서울'] };
    case 'DISTRICTS': {
      const codes = product.region.districtCodes;
      if (codes.length === 0) return null;
      return {
        ...base,
        scope: 'SEOUL_DISTRICTS',
        provinces: ['서울'],
        districts: codes.map((code) => DISTRICT_NAMES.get(code) ?? code),
        districtCodes: [...codes],
      };
    }
    case 'UNKNOWN':
      return null;
  }
}

// 상품에서 읽은 조건. 사람이 등록한 상품은 공식 근거와 함께 적은 사업 단계·지역을 AI 값 대신 쓴다(ADR §3). 자동 상품의
// 사업 단계·지역 필드는 수집기의 추측이라 쓰지 않는다(ADR 0009 Context·§7).
export function readProductConditions(product: FundingProduct, extraction: VerifiedConditions | null): Readings {
  const readings = Object.fromEntries(
    CONDITION_FIELD_NAMES.map((name) => [
      name,
      fromExtraction(extraction?.[name] as VerifiedField<ConditionValues[typeof name]> | undefined),
    ]),
  ) as Readings;
  if (product.origin === 'SYNC') return readings;
  const stage = operatorStage(product);
  const stageEvidence = operatorEvidence(product, 'BUSINESS_STAGE');
  if (stage !== null && stageEvidence !== null) {
    readings.businessStage = { status: 'READ', source: 'OPERATOR', value: stage, evidence: stageEvidence };
  }
  const region = operatorRegion(product);
  const regionEvidence = operatorEvidence(product, 'REGION');
  if (region !== null && regionEvidence !== null) {
    readings.region = { status: 'READ', source: 'OPERATOR', value: region, evidence: regionEvidence };
  }
  return readings;
}

type Judgment = { verdict: MatchVerdict; checkReason: CheckReason | null };
const MATCH: Judgment = { verdict: 'MATCH', checkReason: null };
const MISMATCH: Judgment = { verdict: 'MISMATCH', checkReason: null };
const check = (checkReason: CheckReason): Judgment => ({ verdict: 'CHECK', checkReason });

function inRange(value: number, range: ConditionRange): boolean {
  if (range.min !== null && value < range.min) return false;
  if (range.max !== null && (range.maxExclusive ? value >= range.max : value > range.max)) return false;
  return true;
}

const unlimited = (range: ConditionRange) => range.min === null && range.max === null;

function stageJudgment(value: ConditionValues['businessStage'], profile: FundingMatchProfile): Judgment {
  if (value === 'BOTH') return MATCH;
  if (profile.businessStatus === null) return check('INPUT_MISSING');
  const wanted = value === 'PRE_STARTUP_ONLY' ? 'PRE_STARTUP' : 'BUSINESS';
  return profile.businessStatus === wanted ? MATCH : MISMATCH;
}

const pad = (value: number) => String(value).padStart(2, '0');

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 날짜에 개월을 더한다. 그달에 같은 날이 없으면 말일이다(1월 31일 + 1개월 = 2월 말일).
function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const index = year * 12 + (month - 1) + months;
  const nextYear = Math.floor(index / 12);
  const nextMonth = (index % 12) + 1;
  return `${nextYear}-${pad(nextMonth)}-${pad(Math.min(day, lastDayOfMonth(nextYear, nextMonth)))}`;
}

// 년을 개월로. 0.5년처럼 개월로 떨어지지 않는 값은 날짜로 비교할 수 없어 null이다.
function yearsToMonths(years: number): number | null {
  const months = years * 12;
  const rounded = Math.round(months);
  return Math.abs(months - rounded) < 1e-9 ? rounded : null;
}

// 업력은 개업일부터 기준일까지다. 개업 연월만 알아서 개업일은 그달 1일~말일 중 하나이고, 양 끝에서 결과가 갈리면
// 확인 필요다(기본값). 예비 창업자는 업력 0년으로 본다(기본값).
function businessAgeJudgment(range: ConditionRange, profile: FundingMatchProfile, asOfDate: string): Judgment {
  if (unlimited(range)) return MATCH;
  if (profile.businessStatus === null) return check('INPUT_MISSING');
  if (profile.businessStatus === 'PRE_STARTUP') return inRange(0, range) ? MATCH : MISMATCH;
  if (profile.openedYearMonth === null) return check('INPUT_MISSING');
  const minMonths = range.min === null ? null : yearsToMonths(range.min);
  const maxMonths = range.max === null ? null : yearsToMonths(range.max);
  if ((range.min !== null && minMonths === null) || (range.max !== null && maxMonths === null))
    return check('UNCERTAIN');
  const [year, month] = profile.openedYearMonth.split('-').map(Number);
  const earliest = `${profile.openedYearMonth}-01`;
  if (compareIsoDates(earliest, asOfDate) > 0) return check('UNCERTAIN');
  const monthEnd = `${profile.openedYearMonth}-${pad(lastDayOfMonth(year, month))}`;
  const latest = compareIsoDates(monthEnd, asOfDate) > 0 ? asOfDate : monthEnd;
  // 개업일이 늦을수록 업력이 짧다. 가장 이른 개업일에도 하한에 못 미치거나, 가장 늦은 개업일에도 상한을 넘으면 안 맞음이다.
  const tooYoung = (opened: string) =>
    minMonths !== null && compareIsoDates(addMonths(opened, minMonths), asOfDate) > 0;
  const tooOld = (opened: string) => {
    if (maxMonths === null) return false;
    const limit = compareIsoDates(asOfDate, addMonths(opened, maxMonths));
    return range.maxExclusive ? limit >= 0 : limit > 0;
  };
  if (tooYoung(earliest) || tooOld(latest)) return MISMATCH;
  if (!tooYoung(latest) && !tooOld(earliest)) return MATCH;
  return check('UNCERTAIN');
}

function ageJudgment(range: ConditionRange, profile: FundingMatchProfile): Judgment {
  if (unlimited(range)) return MATCH;
  if (profile.age === null) return check('INPUT_MISSING');
  return inRange(profile.age, range) ? MATCH : MISMATCH;
}

// 자치구는 코드로 맞춘다. 입력이 없어도 결과가 정해지는 경우(제외 지역 없는 전국)만 맞음이고, 나머지는 확인 필요다.
function regionJudgment(value: ConditionValues['region'], profile: FundingMatchProfile): Judgment {
  const district = profile.districtCode;
  if (district === null) {
    const noExclusion = value.excludedProvinces.length === 0 && value.excludedDistrictCodes.length === 0;
    return value.scope === 'NATIONWIDE' && noExclusion ? MATCH : check('INPUT_MISSING');
  }
  // 자치구는 서울 자치구만 고를 수 있다.
  if (value.excludedProvinces.includes('서울') || value.excludedDistrictCodes.includes(district)) return MISMATCH;
  switch (value.scope) {
    case 'NATIONWIDE':
      return MATCH;
    case 'PROVINCES':
      return value.provinces.includes('서울') ? MATCH : MISMATCH;
    case 'SEOUL_DISTRICTS':
      return value.districtCodes.includes(district) ? MATCH : MISMATCH;
  }
}

function foodJudgment(value: ConditionValues['foodBusiness']): Judgment {
  return value === 'EXCLUDED' ? MISMATCH : MATCH;
}

type Membership = boolean | 'INPUT_MISSING' | 'UNCERTAIN';

function membership(
  group: ConditionTargetGroup,
  profile: FundingMatchProfile,
  age: ConditionReading<ConditionRange>,
): Membership {
  if (group === 'OTHER') return 'UNCERTAIN';
  // 재난 피해 대상 공고는 범위 밖이라 피해 소상공인은 입력받지 않고, 해당하지 않는 것으로 본다(사용자 결정 2026-11-03).
  if (group === 'DAMAGED') return false;
  if (group === 'YOUTH') {
    // 청년 한정은 나이로 맞춰 본다(ADR §4). 청년 기준에는 상한이 있으므로, 상한을 읽지 못했으면 청년 기준 나이를 읽지
    // 못한 것이다(하한만 읽으면 누구나 청년이 된다).
    if (age.status !== 'READ' || age.value.max === null) return 'UNCERTAIN';
    if (profile.age === null) return 'INPUT_MISSING';
    return inRange(profile.age, age.value);
  }
  if (profile.targetGroups === null) return 'INPUT_MISSING';
  return profile.targetGroups.includes(group);
}

// 여러 대상은 그중 하나에 해당하면 된다. 어느 것에도 해당하지 않으면 안 맞음, 알 수 없는 대상이 남으면 확인 필요다(ADR §4).
function targetGroupsJudgment(
  value: ConditionValues['targetGroups'],
  profile: FundingMatchProfile,
  age: ConditionReading<ConditionRange>,
): Judgment {
  if (value.groups.length === 0) return MATCH;
  const results = [...new Set(value.groups)].map((group) => membership(group, profile, age));
  if (results.includes(true)) return MATCH;
  if (results.includes('INPUT_MISSING')) return check('INPUT_MISSING');
  if (results.includes('UNCERTAIN')) return check('UNCERTAIN');
  return MISMATCH;
}

function unread(reading: ConditionReading<unknown>): Judgment | null {
  switch (reading.status) {
    case 'NOT_MENTIONED':
      return check('NOT_MENTIONED');
    case 'UNREADABLE':
      return check('UNREADABLE');
    case 'NOT_READ':
      return check('NOT_READ');
    case 'READ':
      return null;
  }
}

export function matchConditions(readings: Readings, profile: FundingMatchProfile, asOfDate: string): ConditionMatch[] {
  const judge = <K extends MatchConditionKey>(
    key: K,
    decide: (value: ConditionValues[K]) => Judgment,
  ): {
    key: K;
    reading: ConditionReading<ConditionValues[K]>;
    verdict: MatchVerdict;
    checkReason: CheckReason | null;
  } => {
    const reading = readings[key] as ConditionReading<ConditionValues[K]>;
    const judgment = unread(reading) ?? decide((reading as { value: ConditionValues[K] }).value);
    return { key, reading, ...judgment };
  };
  // 항목은 서로 묶지 않는다. "청년 또는 여성"의 나이 상한이 청년에만 걸려도 나이는 안 맞음이 된다(알려진 한계).
  return [
    judge('businessStage', (value) => stageJudgment(value, profile)),
    judge('businessAge', (value) => businessAgeJudgment(value, profile, asOfDate)),
    judge('age', (value) => ageJudgment(value, profile)),
    judge('region', (value) => regionJudgment(value, profile)),
    judge('foodBusiness', foodJudgment),
    judge('targetGroups', (value) => targetGroupsJudgment(value, profile, readings.age)),
  ];
}

function closedBy(product: FundingProduct, asOfDate: string): ClosedBy | null {
  if (product.observedApplicationStatus === 'CLOSED') return 'SOURCE_STATUS';
  // 종료일 당일까지는 접수 중이다.
  const end = product.applicationPeriod.end;
  return end !== null && compareIsoDates(end, asOfDate) < 0 ? 'SOURCE_END_DATE' : null;
}

// AI가 읽은 종료일이 지났는지. 소진공은 다른 회차 공지의 날짜를 쓰지 않는데 AI는 그 공지 본문의 지난 날짜를 읽을 수 있어,
// 마감으로 숨기지 않고 접수 여부 미확인으로만 둔다.
function aiEndDatePassed(aiPeriod: ConditionReading<ConditionValues['applicationPeriod']>, asOfDate: string): boolean {
  return aiPeriod.status === 'READ' && aiPeriod.value.end !== null && compareIsoDates(aiPeriod.value.end, asOfDate) < 0;
}

// 기업마당은 지자체 공고의 제목 맨 앞에 [시·도]를 붙인다. 표시가 틀린 공고도 있어 지역 값으로는 쓰지 않는다.
function leadingTitleMark(product: FundingProduct): string | null {
  if (product.origin !== 'SYNC' || product.sourceRef?.source !== 'BIZINFO') return null;
  return /^\s*\[([^\]]+)\]/.exec(product.name)?.[1].trim() ?? null;
}

const NOT_LIMITING_MARKS = ['서울', '전국'];

// 지역이 언급 없음인데 제목 표시가 다른 지역을 가리키면, 언급 없음으로 두지 않고 제목 표시를 이유로 남긴다. 그러면 걸리는 조건
// 안 보임으로 올라가지 않는다. 내리는 데만 쓰고, AI가 지역을 읽었으면 그 값을 그대로 쓴다(ADR §4, 2026-11-13).
function withTitleRegionMark(conditions: ConditionMatch[], mark: string | null): ConditionMatch[] {
  if (mark === null || NOT_LIMITING_MARKS.some((name) => mark.includes(name))) return conditions;
  return conditions.map((entry) =>
    entry.key === 'region' && entry.checkReason === 'NOT_MENTIONED'
      ? { ...entry, checkReason: 'TITLE_REGION_MARK' as const }
      : entry,
  );
}

export function applicationState(application: ProductMatch['application']): ApplicationState {
  if (application.closedBy !== null) return 'CLOSED';
  return application.unconfirmedReasons.length === 0 ? 'OPEN_CONFIRMED' : 'UNCONFIRMED';
}

function conditionGroup(conditions: readonly ConditionMatch[]): Exclude<FundingMatchGroup, 'CLOSED'> {
  if (conditions.some((entry) => entry.verdict === 'MISMATCH')) return 'NOT_MATCHING';
  const checks = conditions.filter((entry) => entry.verdict === 'CHECK');
  if (checks.length === 0) return 'MATCHING';
  return checks.every((entry) => entry.checkReason === 'NOT_MENTIONED') ? 'NOT_MENTIONED_ONLY' : 'NEEDS_CHECK';
}

export function matchProduct(
  product: FundingProduct,
  extraction: VerifiedConditions | null,
  profile: FundingMatchProfile,
  context: { asOfDate: string; automation: FundingAutomation },
): ProductMatch {
  const readings = readProductConditions(product, extraction);
  const titleRegionMark = leadingTitleMark(product);
  const conditions = withTitleRegionMark(matchConditions(readings, profile, context.asOfDate), titleRegionMark);
  const auto = product.origin === 'SYNC';
  const source = auto ? product.sourceRef?.source : undefined;
  const fresh =
    !auto || (source !== undefined && isSourceFresh(source, context.automation.sourceSyncs, context.asOfDate));
  const closed = closedBy(product, context.asOfDate);
  const unconfirmedReasons: OpenUnconfirmedReason[] =
    closed === null
      ? [
          ...(product.observedApplicationStatus === 'OPEN' ? [] : (['STATUS_NOT_OPEN'] as const)),
          ...(fresh ? [] : (['SOURCE_STALE'] as const)),
          ...(aiEndDatePassed(readings.applicationPeriod, context.asOfDate) ? (['AI_END_DATE_PASSED'] as const) : []),
        ]
      : [];
  const group: FundingMatchGroup = closed !== null ? 'CLOSED' : conditionGroup(conditions);
  return {
    productKey: product.productKey,
    version: product.version,
    name: product.name,
    organization: product.organization,
    supportType: product.supportType,
    tab: fundingTab(product),
    group,
    officialUrl: product.officialUrl,
    automation:
      source === undefined
        ? null
        : {
            source,
            sourceLabel: FUNDING_SOURCE_LABELS[source],
            lastSucceededOn:
              context.automation.sourceSyncs.find((entry) => entry.source === source)?.lastSucceededOn ?? null,
            fresh,
          },
    application: {
      status: product.observedApplicationStatus,
      period: product.applicationPeriod,
      aiPeriod: readings.applicationPeriod,
      closedBy: closed,
      unconfirmedReasons,
    },
    conditions,
    supportTypes: readings.supportTypes,
    limit: { publicLimitKrw: product.publicLimit, limitText: product.limitText ?? null },
    operatorRegionNote: auto ? null : product.region.note,
    operatorRecord: auto ? null : { observedAt: product.observedAt },
    titleRegionMark,
  };
}

function emptyCounts(): Record<FundingMatchGroup, number> {
  return { MATCHING: 0, NOT_MENTIONED_ONLY: 0, NEEDS_CHECK: 0, NOT_MATCHING: 0, CLOSED: 0 };
}

// 활성 카탈로그 전체를 맞춰 본다. extractions는 상품 키별로, 그 상품의 지금 본문(noticeTextChecksum)을 지금 모델·프롬프트로
// 읽은 결과만 담는다(match-list.ts). 차단 목록의 자동 상품은 보여 주지 않는다(ADR §6 운영자 숨김).
export function matchCatalog(
  catalog: FundingCatalog,
  extractions: ReadonlyMap<string, VerifiedConditions>,
  profile: FundingMatchProfile,
  options: { asOfDate: string },
): FundingMatchList {
  const blocked = new Set(catalog.automation.blockedSources.map((entry) => sourceRefKey(entry)));
  let hiddenCount = 0;
  const matches = catalog.products.flatMap((product) => {
    const hidden =
      product.origin === 'SYNC' && product.sourceRef !== undefined && blocked.has(sourceRefKey(product.sourceRef));
    const extraction = product.noticeTextChecksum === undefined ? null : (extractions.get(product.productKey) ?? null);
    if (hidden) {
      hiddenCount += 1;
      return [];
    }
    return [matchProduct(product, extraction, profile, { asOfDate: options.asOfDate, automation: catalog.automation })];
  });
  // 그룹 순서로 놓고, 같은 그룹 안에서는 접수 중으로 확인한 공고를 먼저 놓는다(ADR §4).
  const order = (entry: ProductMatch) =>
    FUNDING_MATCH_GROUPS.indexOf(entry.group) * 2 + (applicationState(entry.application) === 'OPEN_CONFIRMED' ? 0 : 1);
  const tabs = Object.fromEntries(
    FUNDING_TABS.map((tab) => {
      // 순서가 같은 공고끼리는 카탈로그 순서를 지킨다(Array.prototype.sort는 안정 정렬이다).
      const products = matches.filter((entry) => entry.tab === tab).sort((a, b) => order(a) - order(b));
      const counts = emptyCounts();
      for (const entry of products) counts[entry.group] += 1;
      return [tab, { counts, products }];
    }),
  ) as FundingMatchList['tabs'];
  return { asOfDate: options.asOfDate, hiddenCount, tabs };
}
