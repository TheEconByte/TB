import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_FUNDING_FORM,
  businessDistrictUnsaved,
  fundingFormFromProfile,
  fundingFormPayload,
  toggleTargetGroup,
  toggleNoTargetGroup,
  type FundingProfileForm,
} from './profile-form.ts';
import { fundingMatchProfileSchema } from './match-profile.ts';
import type { FundingMatchProfile } from './matching.ts';

// 화면 입력을 API 본문으로 바꾼다. 서버와 같은 규칙을 저장 전에 알려, 형식이 틀린 값 때문에 재무 입력까지 함께
// 저장되지 않는 일을 막는다(계획 저장은 한 요청이다). 서버 스키마가 최종 판단이다.

const FORM: FundingProfileForm = {
  businessStatus: 'BUSINESS',
  openedYearMonth: '2024-03',
  districtCode: '11440',
  age: '35',
  targetGroups: ['WOMEN'],
};

afterEach(() => {
  vi.useRealTimers();
});

describe('자금 조건 입력란 → 본문', () => {
  it('아무것도 입력하지 않으면 EMPTY다', () => {
    // 계획 화면은 이때 null을 보내 "조건 없음"과 "모두 입력하지 않음"을 구분하던 기존 규칙을 잇는다.
    expect(fundingFormPayload(EMPTY_FUNDING_FORM)).toEqual({ kind: 'EMPTY' });
    expect(fundingFormPayload({ ...EMPTY_FUNDING_FORM, age: '  ' })).toEqual({ kind: 'EMPTY' });
  });

  it('입력한 값을 서버 스키마가 받는 모양으로 바꾼다', () => {
    const payload = fundingFormPayload(FORM);
    expect(payload).toEqual({
      kind: 'OK',
      profile: {
        businessStatus: 'BUSINESS',
        openedYearMonth: '2024-03',
        districtCode: '11440',
        age: 35,
        targetGroups: ['WOMEN'],
      },
    });
    if (payload.kind === 'OK') expect(fundingMatchProfileSchema.parse(payload.profile)).toEqual(payload.profile);
  });

  it('사업자가 아니면 개업 연월 입력란 값을 보내지 않는다', () => {
    // 사업자에서 예비 창업자로 바꾼 뒤 남은 개업 연월이 서버에서 400이 되지 않게 한다.
    const payload = fundingFormPayload({ ...FORM, businessStatus: 'PRE_STARTUP' });
    expect(payload.kind === 'OK' && payload.profile.openedYearMonth).toBeNull();
  });

  it('나이가 0~120의 정수가 아니면 저장 전에 알린다', () => {
    // 입력란은 받은 글자를 그대로 넘긴다(FundingProfileFields). "35세"를 입력하지 않음으로 바꾸지 않고 알린다.
    for (const age of ['34.5', '-1', '121', '서른', '35세', '1e2', '3 5']) {
      const payload = fundingFormPayload({ ...FORM, age });
      expect(payload.kind, age).toBe('INVALID');
    }
    expect(fundingFormPayload({ ...FORM, age: ' 7 ' })).toMatchObject({ kind: 'OK', profile: { age: 7 } });
  });

  it('개업 연월이 실제 달이 아니거나 이번 달보다 늦으면 저장 전에 알린다', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-03T03:00:00.000Z'));
    for (const openedYearMonth of ['2024-13', '202413', '20243', '2024-', '2024년 3월', '2026-12', '202612']) {
      expect(fundingFormPayload({ ...FORM, openedYearMonth }).kind, openedYearMonth).toBe('INVALID');
    }
    expect(fundingFormPayload({ ...FORM, openedYearMonth: '2026-11' }).kind).toBe('OK');
    // iOS 숫자 키패드에는 "-"가 없어 붙여 쓴 6자리로 입력한다. 점·빗금·공백으로 나눈 표기와 한 자리 달도 받는다.
    // 서버 스키마는 YYYY-MM만 받으므로 보낼 때 그 모양으로 바꾼다.
    for (const typed of ['202403', '2024.03', '2024. 3.', '2024/3', '2024 3', '2024-3', ' 2024-03 ']) {
      expect(fundingFormPayload({ ...FORM, openedYearMonth: typed }), typed).toMatchObject({
        kind: 'OK',
        profile: { openedYearMonth: '2024-03' },
      });
    }
    // 사업자인데 개업 연월을 비우면 입력하지 않음이다(업력은 확인 필요로 남는다).
    expect(fundingFormPayload({ ...FORM, openedYearMonth: '' })).toMatchObject({
      kind: 'OK',
      profile: { openedYearMonth: null },
    });
  });
});

describe('대상 한정의 세 상태', () => {
  // 답하지 않음(null)·해당 없음([])·고른 대상. 장애 여부는 민감한 답이라 답하지 않을 수 있어야 한다(ADR Consequences).
  it('아무것도 고르지 않으면 답하지 않음이다', () => {
    expect(fundingFormPayload({ ...FORM, targetGroups: null })).toMatchObject({
      kind: 'OK',
      profile: { targetGroups: null },
    });
  });

  it('해당 없음을 고르면 빈 목록이고, 대상을 고르면 해당 없음이 풀린다', () => {
    expect(toggleNoTargetGroup(null, true)).toEqual([]);
    expect(toggleNoTargetGroup(['WOMEN'], true)).toEqual([]);
    expect(toggleNoTargetGroup([], false)).toBeNull();
    expect(toggleTargetGroup([], 'DISABLED', true)).toEqual(['DISABLED']);
    expect(toggleTargetGroup(null, 'RESTART', true)).toEqual(['RESTART']);
  });

  it('마지막 대상을 풀면 해당 없음이 아니라 답하지 않음으로 돌아간다', () => {
    expect(toggleTargetGroup(['WOMEN'], 'WOMEN', false)).toBeNull();
    expect(toggleTargetGroup(['WOMEN', 'RESTART'], 'WOMEN', false)).toEqual(['RESTART']);
  });

  it('대상 순서는 고른 순서와 상관없이 같다', () => {
    // 같은 답이면 저장 전 변경 여부(dirty)가 같게 나와야 한다.
    expect(toggleTargetGroup(['RESTART'], 'WOMEN', true)).toEqual(['WOMEN', 'RESTART']);
  });
});

describe('저장된 조건 → 입력란', () => {
  it('본문으로 바꿨다가 되돌리면 같은 입력란이 된다', () => {
    const profiles: FundingMatchProfile[] = [
      { businessStatus: null, openedYearMonth: null, districtCode: null, age: null, targetGroups: null },
      { businessStatus: 'PRE_STARTUP', openedYearMonth: null, districtCode: '11200', age: 0, targetGroups: [] },
      {
        businessStatus: 'BUSINESS',
        openedYearMonth: '2020-01',
        districtCode: null,
        age: 61,
        targetGroups: ['DISABLED'],
      },
    ];
    for (const profile of profiles) {
      const form = fundingFormFromProfile(profile);
      const payload = fundingFormPayload(form);
      const empty = Object.values(profile).every((value) => value === null);
      expect(payload).toEqual(empty ? { kind: 'EMPTY' } : { kind: 'OK', profile });
    }
  });
});

describe('사업 조건 자치구의 저장 전 변경', () => {
  // 자금 조건의 자치구가 비면 서버는 저장된 사업 조건의 자치구로 맞춰 본다(ADR 0009 §4). 화면에서 바꾼 사업 조건 자치구가
  // 저장되기 전에 조회하면 화면과 다른 자치구로 맞춰진다.
  const empty = { ...FORM, districtCode: '' };

  it('자금 조건의 자치구가 비어 있고 사업 조건 자치구가 저장된 것과 다르면 저장 전 변경이다', () => {
    expect(businessDistrictUnsaved(empty, '11200', '11440')).toBe(true);
    // 처음 입력한 사업 조건 자치구도 저장 전에는 서버가 모른다.
    expect(businessDistrictUnsaved(empty, '11200', null)).toBe(true);
    // 저장된 사업 조건 자치구를 화면에서 지운 경우도 같다.
    expect(businessDistrictUnsaved(empty, '', '11440')).toBe(true);
  });

  it('서울 자치구가 아닌 사업 조건 자치구는 서버처럼 없는 것으로 보고 비교한다', () => {
    // 서버는 서울 자치구 코드만 보충에 쓴다(match-profile.ts). 화면 값을 그대로 비교하면 저장해도 풀리지 않는 막힘이 된다.
    expect(businessDistrictUnsaved(empty, '41110', null)).toBe(false);
    expect(businessDistrictUnsaved(empty, '41110', '11440')).toBe(true);
  });

  it('같거나, 자금 조건의 자치구가 있으면 사업 조건 자치구와 상관없다', () => {
    expect(businessDistrictUnsaved(empty, '11440', '11440')).toBe(false);
    expect(businessDistrictUnsaved(empty, '', null)).toBe(false);
    expect(businessDistrictUnsaved(FORM, '11200', '11440')).toBe(false);
  });
});
