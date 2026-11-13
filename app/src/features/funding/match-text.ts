import type { ValueResult } from '../finance/types.ts';
import type { ConditionRange, ConditionTargetGroup, ConditionValues } from './condition-fields.ts';
import { toDate } from './dates.ts';
import { districtName } from './districts.ts';
import type { DistrictSource } from './match-profile.ts';
import {
  REMAINING_GROUPS,
  applicationState,
  type CheckReason,
  type ConditionMatch,
  type FundingMatchGroup,
  type FundingMatchProfile,
  type FundingTab,
  type MatchConditionKey,
  type MatchVerdict,
  type OpenUnconfirmedReason,
  type ProductMatch,
  type UserTargetGroup,
} from './matching.ts';
import type { SupportType } from './types.ts';

// 맞춰 보기 화면의 문장(ADR 0009 §4). 판정 코드를 사람이 읽는 문장으로 바꾼다. React에 의존하지 않아 테스트가 모든 분기의
// 문장을 확인한다. 맞아 보여도 자격이나 결정이 확정된 것처럼 쓰지 않는다(PRODUCT.md 원칙 5).

export const AI_READING_NOTICE = 'AI가 공고문에서 읽은 내용입니다. 신청 전 원 공고를 확인하세요';
export const LIMIT_NOTE = '한도는 공고가 밝힌 최대치이며 실제 금액은 심사로 정해집니다.';

export const FUNDING_TAB_LABELS: Record<FundingTab, string> = {
  POLICY_FUND: '정책자금',
  SUPPORT_PROGRAM: '지원사업',
};

// 카드에 그룹을 표시하는 것은 목록에서 뺀 공고와 마감 공고뿐이다. 남은 공고는 그룹 제목 없이 한 목록이다.
export const FUNDING_GROUP_BADGE_LABELS: Record<Extract<FundingMatchGroup, 'NOT_MATCHING' | 'CLOSED'>, string> = {
  NOT_MATCHING: '안 맞아 보임',
  CLOSED: '마감',
};

// 탭 제목에 쓰는 공고 수. 목록에 남은 공고와 조건에 안 맞아 뺀 공고를 쓴다(마감은 탭 안에 있다). 폰 폭에서는 줄이 바뀌므로
// 따로 돌려주고, 수는 줄바꿈 없는 공백으로 이름에 붙인다.
export function tabCountTexts(counts: Record<FundingMatchGroup, number>): string[] {
  const remaining = REMAINING_GROUPS.reduce((sum, group) => sum + counts[group], 0);
  return [
    `남은 공고\u00a0${numberFormat.format(remaining)}`,
    `조건에 안 맞아 뺌\u00a0${numberFormat.format(counts.NOT_MATCHING)}`,
  ];
}

// 카드에 조건을 나눠 적는 두 묶음. 공고가 밝힌 조건(읽은 값과 인용이 있다)과 직접 확인할 조건(AI가 읽지 못했거나 아직 읽지
// 않았거나, 공고문에는 없는데 제목에 다른 지역 표시가 있다)이다. 공고문에서 찾지 못한 조건은 카드에 적지 않는다(사용자 결정
// 2026-11-13). 없다고 제한이 없다는 뜻은 아니라는 점은 목록 설명에서 한 번 알린다.
export function conditionSections(conditions: readonly ConditionMatch[]): {
  stated: ConditionMatch[];
  toCheck: ConditionMatch[];
} {
  return {
    stated: conditions.filter((entry) => entry.reading.status === 'READ'),
    toCheck: conditions.filter((entry) => entry.reading.status !== 'READ' && entry.checkReason !== 'NOT_MENTIONED'),
  };
}

export const MATCH_VERDICT_LABELS: Record<MatchVerdict, string> = {
  MATCH: '맞음',
  MISMATCH: '안 맞음',
  CHECK: '확인 필요',
};

export const CONDITION_LABELS: Record<MatchConditionKey, string> = {
  businessStage: '사업 단계',
  businessAge: '업력',
  age: '나이',
  region: '지역',
  foodBusiness: '음식점·카페',
  targetGroups: '대상 한정',
};

export const USER_TARGET_GROUP_LABELS: Record<UserTargetGroup, string> = {
  WOMEN: '여성',
  DISABLED: '장애인',
  RESTART: '재창업',
};

const TARGET_GROUP_LABELS: Record<ConditionTargetGroup, string> = {
  YOUTH: '청년',
  ...USER_TARGET_GROUP_LABELS,
  DAMAGED: '피해 소상공인',
  OTHER: '그 밖의 대상',
};

// 카탈로그의 지원 유형. 지원금·보증·공간·프로그램을 대출처럼 보이게 쓰지 않는다.
export const SUPPORT_TYPE_LABELS: Record<SupportType, string> = {
  GRANT: '지원금(상환 없음)',
  GUARANTEE: '보증(대출 아님)',
  LOAN: '대출(상환 대상)',
  SPACE: '공간·보육(대출 아님)',
  PROGRAM: '프로그램(대출 아님)',
  UNKNOWN: '유형 미확인',
};

const CONDITION_SUPPORT_TYPE_LABELS: Record<ConditionValues['supportTypes'][number], string> = {
  LOAN: '대출',
  GUARANTEE: '보증',
  GRANT: '지원금',
  SPACE: '공간',
  PROGRAM: '교육·프로그램',
  OTHER: '기타',
};

const numberFormat = new Intl.NumberFormat('ko-KR');

export function formatWon(value: string): string {
  return `${numberFormat.format(BigInt(value))}원`;
}

// 카탈로그 날짜는 UTC 자정으로 다룬다(dates.ts). 보는 사람의 시간대로 하루가 밀리지 않게 UTC로 쓴다.
export function formatDate(value: string | null): string {
  if (value === null) return '기록 없음';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('ko-KR', { timeZone: 'UTC' });
}

function formatYearMonth(value: string): string {
  const [year, month] = value.split('-');
  return `${year}년 ${Number(month)}월`;
}

const join = (values: readonly string[]) => values.join('·');

// ConditionRange: null인 쪽은 제한 없음, maxExclusive면 미만이다(condition-fields.ts).
export function rangeText(kind: 'age' | 'businessAge', range: ConditionRange): string {
  const unit = kind === 'age' ? '세' : '년';
  if (range.min === null && range.max === null) return kind === 'age' ? '나이 제한 없음' : '업력 제한 없음';
  const parts = [
    ...(range.min === null ? [] : [`${range.min}${unit} 이상`]),
    ...(range.max === null ? [] : [`${range.max}${unit} ${range.maxExclusive ? '미만' : '이하'}`]),
  ];
  return `${kind === 'age' ? '만' : '업력'} ${parts.join(' ')}`;
}

function regionText(value: ConditionValues['region']): string {
  const base =
    value.scope === 'NATIONWIDE'
      ? '전국'
      : value.scope === 'PROVINCES'
        ? join(value.provinces)
        : `서울 ${join(value.districts)}`;
  const excluded = [...value.excludedProvinces, ...value.excludedDistricts];
  return excluded.length === 0 ? base : `${base} (제외: ${join(excluded)})`;
}

function targetGroupsText(value: ConditionValues['targetGroups']): string {
  if (value.groups.length === 0) return '대상 한정 없음';
  return [...new Set(value.groups)]
    .map((group) =>
      group === 'OTHER' && value.note !== null
        ? `${TARGET_GROUP_LABELS.OTHER}(${value.note})`
        : TARGET_GROUP_LABELS[group],
    )
    .join(' · ');
}

// 읽은 값을 문장으로 쓴다. 읽지 않았으면 null이다.
export function conditionValueText(condition: ConditionMatch): string | null {
  if (condition.reading.status !== 'READ') return null;
  switch (condition.key) {
    case 'businessStage': {
      const value = (condition.reading as { value: ConditionValues['businessStage'] }).value;
      return value === 'PRE_STARTUP_ONLY'
        ? '예비 창업자만'
        : value === 'BUSINESS_ONLY'
          ? '사업자만'
          : '예비 창업자·사업자 모두';
    }
    case 'businessAge':
      return rangeText('businessAge', (condition.reading as { value: ConditionRange }).value);
    case 'age':
      return rangeText('age', (condition.reading as { value: ConditionRange }).value);
    case 'region':
      return regionText((condition.reading as { value: ConditionValues['region'] }).value);
    case 'foodBusiness':
      return (condition.reading as { value: ConditionValues['foodBusiness'] }).value === 'EXCLUDED'
        ? '음식점·카페를 지원 대상에서 뺌'
        : '음식점·카페를 지원 대상에서 빼지 않음';
    case 'targetGroups':
      return targetGroupsText((condition.reading as { value: ConditionValues['targetGroups'] }).value);
  }
}

const INPUT_MISSING_TEXT: Record<MatchConditionKey, string> = {
  businessStage: '사업자등록 여부를 입력하면 맞춰 볼 수 있습니다.',
  businessAge: '사업자등록 여부와 개업 연월을 입력하면 맞춰 볼 수 있습니다.',
  age: '대표자 나이를 입력하면 맞춰 볼 수 있습니다.',
  region: '자치구를 입력하면 맞춰 볼 수 있습니다.',
  foodBusiness: '입력이 더 있어야 맞춰 볼 수 있습니다.',
  targetGroups: '대상 한정(청년이면 나이)을 입력하면 맞춰 볼 수 있습니다.',
};

const UNCERTAIN_TEXT: Record<MatchConditionKey, string> = {
  businessStage: '입력만으로는 맞는지 정할 수 없습니다. 원 공고에서 확인하세요.',
  businessAge:
    '개업 연월만으로는 업력 기준에 드는지 정할 수 없습니다(개업일이나 공고의 업력 표기에 따라 달라집니다). 원 공고에서 확인하세요.',
  age: '입력만으로는 맞는지 정할 수 없습니다. 원 공고에서 확인하세요.',
  region: '입력만으로는 맞는지 정할 수 없습니다. 원 공고에서 확인하세요.',
  foodBusiness: '입력만으로는 맞는지 정할 수 없습니다. 원 공고에서 확인하세요.',
  targetGroups:
    '입력으로 알 수 없는 대상이 있습니다(그 밖의 대상이거나, 청년 나이 기준을 읽지 못함). 원 공고에서 확인하세요.',
};

const reasonOf = (reading: ConditionMatch['reading']) =>
  reading.status === 'UNREADABLE' ? reading.reason : '원문을 근거로 읽지 못했습니다.';

// 확인 필요의 이유(matching.ts의 CheckReason)를 문장으로 쓴다. 맞음·안 맞음이면 null이다.
export function checkReasonText(condition: ConditionMatch, titleRegionMark: string | null): string | null {
  const reason: CheckReason | null = condition.checkReason;
  if (condition.verdict !== 'CHECK' || reason === null) return null;
  switch (reason) {
    case 'TITLE_REGION_MARK':
      // 표시를 받지 못했으면 지어내지 않고, 그 밑에 있는 사실(언급 없음)만 쓴다.
      if (titleRegionMark !== null)
        return `제목에 [${titleRegionMark}] 표시가 있는데, AI가 공고문에서 지역 조건을 찾지 못했습니다. 서울에서도 신청할 수 있는지 원 공고에서 확인하세요.`;
    // falls through
    case 'NOT_MENTIONED':
      return 'AI가 공고문에서 이 조건을 찾지 못했습니다(언급 없음). 원 공고에서 확인하세요.';
    case 'UNREADABLE':
      return `AI가 이 조건을 읽지 못했습니다: ${reasonOf(condition.reading)} 원 공고에서 확인하세요.`;
    case 'NOT_READ':
      return '이 공고의 조건은 아직 읽지 않았습니다(읽을 본문이 없거나 추출 전). 원 공고에서 확인하세요.';
    case 'INPUT_MISSING':
      return INPUT_MISSING_TEXT[condition.key];
    case 'UNCERTAIN':
      return UNCERTAIN_TEXT[condition.key];
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

// 카드에 그룹과 따로 보여 주는 접수 상태(matching.ts의 ApplicationState). 마감은 그룹 표시가 이미 알리므로 따로 쓰지
// 않는다(null). 접수 중으로 확인한 공고에만 출처 종료일까지 남은 날을 쓴다. 접수 중인지 모르는 공고에 남은 날을 쓰면 접수
// 중으로 읽힌다.
export function applicationStateText(product: ProductMatch, asOfDate: string): string | null {
  switch (applicationState(product.application)) {
    case 'CLOSED':
      return null;
    case 'UNCONFIRMED':
      return '접수 여부 미확인';
    case 'OPEN_CONFIRMED': {
      const { end } = product.application.period;
      if (end === null) return '접수 중 확인';
      const days = Math.round((toDate(end).getTime() - toDate(asOfDate).getTime()) / DAY_MS);
      return days === 0 ? '접수 중 확인 · 오늘 마감' : `접수 중 확인 · 마감까지 ${days}일`;
    }
  }
}

// 접수 중으로 확인하지 못한 이유(matching.ts의 OpenUnconfirmedReason).
export function unconfirmedReasonText(reason: OpenUnconfirmedReason, product: ProductMatch): string {
  switch (reason) {
    case 'STATUS_NOT_OPEN':
      return '출처에서 접수 중인지 확인하지 못했습니다. 원 공고에서 접수 여부를 확인하세요.';
    case 'SOURCE_STALE': {
      const source = product.automation?.sourceLabel ?? '출처';
      return `${source} 확인이 끊겼습니다(마지막 확인 ${formatDate(product.automation?.lastSucceededOn ?? null)}, 3일 넘음). 그 뒤 공고 상태가 바뀌었을 수 있습니다.`;
    }
    case 'AI_END_DATE_PASSED': {
      const { aiPeriod } = product.application;
      const end = aiPeriod.status === 'READ' ? aiPeriod.value.end : null;
      return `AI가 공고문에서 읽은 신청 종료일(${formatDate(end)})이 지났습니다. 다른 회차의 날짜일 수 있어 마감으로 숨기지 않았습니다. 원 공고에서 접수 기간을 확인하세요.`;
    }
  }
}

// 마감의 근거. 출처·운영자 데이터로만 정한다(matching.ts의 ClosedBy).
export function closedText(product: ProductMatch): string | null {
  switch (product.application.closedBy) {
    case null:
      return null;
    case 'SOURCE_STATUS':
      return '출처나 운영자 기록에서 접수 마감으로 확인했습니다.';
    case 'SOURCE_END_DATE':
      return `신청 종료일(${formatDate(product.application.period.end)})이 지났습니다.`;
  }
}

// 신청기간 문장. 한쪽 날짜만 있으면 빈 쪽은 비워 두고(예: "2026. 10. 1. ~"), 날짜 대신 적힌 문장을 괄호로 붙인다.
function periodText(start: string | null, end: string | null, note: string | null): string {
  if (start === null && end === null) return note ?? '기록 없음';
  const range = `${start === null ? '' : formatDate(start)} ~ ${end === null ? '' : formatDate(end)}`.trim();
  return note === null ? range : `${range} (${note})`;
}

// 출처·운영자가 기록한 신청기간.
export function applicationPeriodText(period: ProductMatch['application']['period']): string {
  return periodText(period.start, period.end, period.note);
}

export function aiPeriodText(value: ConditionValues['applicationPeriod']): string {
  return periodText(value.start, value.end, value.text);
}

export function supportTypesText(values: ConditionValues['supportTypes']): string {
  return values.map((value) => CONDITION_SUPPORT_TYPE_LABELS[value]).join(' · ');
}

// 정책자금 카드의 한도 문장. 출처가 준 한도 문장을 먼저 쓰고, 없으면 공개 한도 금액을 쓴다.
export function limitText(limit: ProductMatch['limit']): string {
  if (limit.limitText !== null) return `한도(공고 문장): ${limit.limitText}`;
  if (limit.publicLimitKrw !== null) return `공개 한도: ${formatWon(limit.publicLimitKrw)}`;
  return '공고에서 한도를 확인하지 못했습니다.';
}

// 보고 있는 저장 결과의 계획 부족자금. 다시 계산하지 않고 저장된 결과의 값만 쓴다.
export type ViewedFundingGap = { revision: number; value: ValueResult<string> } | null;

export function fundingGapText(gap: ViewedFundingGap): string {
  if (gap === null) return '저장 결과를 열면 그 결과의 계획 부족자금을 한도 옆에 참고로 보여 줍니다.';
  if (gap.value.status === 'READY')
    return `참고: 보고 있는 저장 결과(revision ${gap.revision})의 계획 부족자금 ${formatWon(gap.value.value)}`;
  return `참고: 보고 있는 저장 결과(revision ${gap.revision})에서는 입력이 부족해 계획 부족자금을 계산하지 못했습니다.`;
}

// 맞춰 본 입력 요약. 입력하지 않음과 해당 없음을 구분하고, 사업 조건에서 가져온 자치구는 그렇다고 밝힌다.
export function fundingProfileSummary(profile: FundingMatchProfile, districtSource: DistrictSource): string {
  const status =
    profile.businessStatus === null
      ? '사업자등록 여부 미입력'
      : profile.businessStatus === 'PRE_STARTUP'
        ? '예비 창업자'
        : profile.openedYearMonth === null
          ? '사업자(개업 연월 미입력)'
          : `사업자(개업 ${formatYearMonth(profile.openedYearMonth)})`;
  const district =
    profile.districtCode === null
      ? '자치구 미입력'
      : `${districtName(profile.districtCode)}${districtSource === 'BUSINESS_PROFILE' ? '(사업 조건의 자치구)' : ''}`;
  const age = profile.age === null ? '나이 미입력' : `만 ${profile.age}세`;
  const groups =
    profile.targetGroups === null
      ? '대상 한정 답하지 않음'
      : profile.targetGroups.length === 0
        ? '대상 한정 해당 없음'
        : `대상 한정 ${profile.targetGroups.map((group) => USER_TARGET_GROUP_LABELS[group]).join('·')}`;
  return [status, district, age, groups].join(' · ');
}
