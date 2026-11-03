import { MAX_AGE, YEAR_MONTH_PATTERN, isFutureYearMonth } from './match-profile.ts';
import { USER_TARGET_GROUPS, type FundingMatchProfile, type UserTargetGroup } from './matching.ts';

// 자금 조건 입력란의 상태. /funding과 계획 화면이 함께 쓴다. 빈 입력란은 빈 문자열로 다루고, 본문으로 바꿀 때만
// null(입력하지 않음)로 바꾼다. 형식은 서버 스키마(match-profile.ts)와 같은 규칙으로 저장 전에 알린다.
export type FundingProfileForm = {
  businessStatus: '' | 'PRE_STARTUP' | 'BUSINESS';
  // 사업자일 때만 보낸다.
  openedYearMonth: string;
  districtCode: string;
  age: string;
  // null은 답하지 않음, 빈 목록은 해당 없음이다.
  targetGroups: UserTargetGroup[] | null;
};

export const EMPTY_FUNDING_FORM: FundingProfileForm = {
  businessStatus: '',
  openedYearMonth: '',
  districtCode: '',
  age: '',
  targetGroups: null,
};

export type FundingFormPayload =
  { kind: 'EMPTY' } | { kind: 'OK'; profile: FundingMatchProfile } | { kind: 'INVALID'; issue: string };

export function fundingFormPayload(form: FundingProfileForm): FundingFormPayload {
  const age = form.age.trim();
  if (age !== '' && (!/^\d{1,3}$/.test(age) || Number(age) > MAX_AGE))
    return { kind: 'INVALID', issue: `대표자 나이는 0~${MAX_AGE} 사이의 정수(만 나이)로 입력해 주세요.` };
  const business = form.businessStatus === 'BUSINESS';
  const month = business ? form.openedYearMonth.trim() : '';
  if (month !== '' && !YEAR_MONTH_PATTERN.test(month))
    return { kind: 'INVALID', issue: '개업 연월은 2024-03처럼 연도와 01~12월로 입력해 주세요.' };
  if (month !== '' && isFutureYearMonth(month))
    return { kind: 'INVALID', issue: '개업 연월은 이번 달보다 늦을 수 없습니다.' };
  const profile: FundingMatchProfile = {
    businessStatus: form.businessStatus === '' ? null : form.businessStatus,
    openedYearMonth: month === '' ? null : month,
    districtCode: form.districtCode === '' ? null : form.districtCode,
    age: age === '' ? null : Number(age),
    targetGroups: form.targetGroups === null ? null : [...form.targetGroups],
  };
  return Object.values(profile).every((value) => value === null) ? { kind: 'EMPTY' } : { kind: 'OK', profile };
}

export function fundingFormFromProfile(profile: FundingMatchProfile): FundingProfileForm {
  return {
    businessStatus: profile.businessStatus ?? '',
    openedYearMonth: profile.openedYearMonth ?? '',
    districtCode: profile.districtCode ?? '',
    age: profile.age === null ? '' : String(profile.age),
    targetGroups: profile.targetGroups === null ? null : [...profile.targetGroups],
  };
}

// 대상을 고르거나 푼다. 순서는 USER_TARGET_GROUPS를 따르고, 마지막 대상을 풀면 답하지 않음으로 돌아간다.
export function toggleTargetGroup(
  current: UserTargetGroup[] | null,
  group: UserTargetGroup,
  checked: boolean,
): UserTargetGroup[] | null {
  const selected = new Set(current ?? []);
  if (checked) selected.add(group);
  else selected.delete(group);
  const next = USER_TARGET_GROUPS.filter((entry) => selected.has(entry));
  return next.length === 0 ? null : next;
}

// 해당 없음을 고르면 고른 대상을 비우고, 풀면 답하지 않음으로 돌아간다.
export function toggleNoTargetGroup(_current: UserTargetGroup[] | null, checked: boolean): UserTargetGroup[] | null {
  return checked ? [] : null;
}
