import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fundingMatchProfileSchema,
  readStoredFundingProfile,
  withBusinessDistrict,
  type StoredFundingProfile,
} from './match-profile.ts';
import type { FundingMatchProfile } from './matching.ts';

// ADR 0009 §4의 입력: 사업자등록 여부, 개업 연월, 자치구, 나이, 대상 한정(여성·장애인·재창업). 업종·용도는 받지 않는다.
// 5b 인계: 형식 검증(개업 연월 01~12·미래 아님, 정수 나이, 서울 자치구 코드)은 호출자 몫이다(matching.ts는 다시 검사하지 않는다).

const FULL: FundingMatchProfile = {
  businessStatus: 'BUSINESS',
  openedYearMonth: '2024-03',
  districtCode: '11440',
  age: 35,
  targetGroups: ['WOMEN', 'RESTART'],
};
const NO_INPUT: FundingMatchProfile = {
  businessStatus: null,
  openedYearMonth: null,
  districtCode: null,
  age: null,
  targetGroups: null,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('자금 조건 입력 스키마', () => {
  it('다섯 항목을 받고, 각 항목은 null(입력하지 않음)일 수 있다', () => {
    expect(fundingMatchProfileSchema.parse(FULL)).toEqual(FULL);
    expect(fundingMatchProfileSchema.parse(NO_INPUT)).toEqual(NO_INPUT);
    // 대상 한정의 빈 목록은 해당 없음이고 null(답하지 않음)과 다르다(matching.ts의 FundingMatchProfile).
    expect(fundingMatchProfileSchema.parse({ ...NO_INPUT, targetGroups: [] }).targetGroups).toEqual([]);
    expect(fundingMatchProfileSchema.parse({ ...FULL, businessStatus: 'PRE_STARTUP', openedYearMonth: null })).toEqual({
      ...FULL,
      businessStatus: 'PRE_STARTUP',
      openedYearMonth: null,
    });
  });

  it('실제 달이 아닌 개업 연월을 거부한다', () => {
    for (const openedYearMonth of ['2024-00', '2024-13', '2024-3', '202403', '2024-03-01', '24-03', '']) {
      expect(fundingMatchProfileSchema.safeParse({ ...FULL, openedYearMonth }).success, openedYearMonth).toBe(false);
    }
  });

  it('개업 연월은 한국 시간 이번 달까지 받고 다음 달부터 거부한다', () => {
    vi.useFakeTimers();
    // UTC로는 10월 31일이지만 한국 시간으로는 11월 1일 00:30이다. 판정 기준일(todayInKst)과 같은 날짜를 쓴다.
    vi.setSystemTime(new Date('2026-10-31T15:30:00.000Z'));
    expect(fundingMatchProfileSchema.safeParse({ ...FULL, openedYearMonth: '2026-11' }).success).toBe(true);
    expect(fundingMatchProfileSchema.safeParse({ ...FULL, openedYearMonth: '2026-12' }).success).toBe(false);
    expect(fundingMatchProfileSchema.safeParse({ ...FULL, openedYearMonth: '2027-01' }).success).toBe(false);
  });

  it('개업 연월은 사업자일 때만 받는다', () => {
    // 예비 창업자의 업력은 0년으로 본다(matching.ts). 개업 연월이 함께 저장되면 어느 쪽이 맞는지 알 수 없다.
    for (const businessStatus of ['PRE_STARTUP', null]) {
      expect(fundingMatchProfileSchema.safeParse({ ...FULL, businessStatus }).success, String(businessStatus)).toBe(
        false,
      );
    }
  });

  it('나이는 0~120의 정수만 받는다', () => {
    // 0~120은 AI가 읽은 나이 조건을 받아들이는 범위와 같다(notice-extraction.ts의 검증).
    for (const age of [0, 19, 120]) expect(fundingMatchProfileSchema.safeParse({ ...FULL, age }).success).toBe(true);
    for (const age of [34.5, -1, 121, '35', Number.NaN]) {
      expect(fundingMatchProfileSchema.safeParse({ ...FULL, age }).success, String(age)).toBe(false);
    }
  });

  it('자치구는 서울 25개 자치구 코드만 받는다', () => {
    for (const districtCode of ['1144', '41135', '11000', 11440]) {
      expect(fundingMatchProfileSchema.safeParse({ ...FULL, districtCode }).success, String(districtCode)).toBe(false);
    }
  });

  it('대상 한정은 여성·장애인·재창업만 한 번씩 받는다', () => {
    // 청년은 나이로 맞춰 보고(ADR §4), 재난 피해 소상공인은 범위 밖이라 입력받지 않는다(사용자 결정 2026-11-03).
    for (const targetGroups of [['YOUTH'], ['DAMAGED'], ['OTHER'], ['WOMEN', 'WOMEN'], 'WOMEN']) {
      expect(fundingMatchProfileSchema.safeParse({ ...FULL, targetGroups }).success, String(targetGroups)).toBe(false);
    }
  });

  it('없앤 업종·용도와 그 밖의 키를 받지 않는다', () => {
    for (const extra of [{ industryCode: 'CS100001' }, { purpose: 'OPERATING_FUNDS' }, { asOfDate: '2000-01-01' }]) {
      expect(fundingMatchProfileSchema.safeParse({ ...FULL, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    // 항목이 빠진 본문도 받지 않는다. 빠진 항목을 입력하지 않음으로 대신 채우지 않는다.
    const { age: _age, ...withoutAge } = FULL;
    expect(fundingMatchProfileSchema.safeParse(withoutAge).success).toBe(false);
  });
});

describe('저장된 자금 조건 읽기', () => {
  const ok = (value: unknown): Extract<StoredFundingProfile, { kind: 'OK' }> => {
    const stored = readStoredFundingProfile(value);
    if (stored.kind !== 'OK') throw new Error(`OK가 아닙니다: ${stored.kind}`);
    return stored;
  };

  it('저장한 적 없는 조건은 NONE이다', () => {
    expect(readStoredFundingProfile(null)).toEqual({ kind: 'NONE' });
    expect(readStoredFundingProfile(undefined)).toEqual({ kind: 'NONE' });
  });

  it('지금 모양은 그대로 읽는다', () => {
    expect(ok(FULL)).toEqual({ kind: 'OK', profile: FULL, legacy: false });
  });

  it('저장한 개업 연월은 읽는 쪽 시계와 상관없이 읽는다', () => {
    // 저장할 때 이미 이번 달까지로 검사했다. 시계가 늦은 브라우저가 저장한 값을 버리면 안 된다.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2020-01-01T00:00:00.000Z'));
    expect(ok(FULL).profile.openedYearMonth).toBe('2024-03');
  });

  it('예전 모양은 사업 단계와 자치구만 옮기고 업종·용도는 버린다', () => {
    // 사용자 결정(2026-11-03): 사업 단계·자치구를 옮기고 업종·용도만 버린다. 읽을 때 바꾸고 다음 저장 때 새 모양으로 쓴다.
    const pre = ok({
      businessStage: 'PRE_REGISTRATION',
      districtCode: '11200',
      industryCode: 'CS100010',
      purpose: 'OPERATING_FUNDS',
    });
    expect(pre).toEqual({
      kind: 'OK',
      legacy: true,
      // 예전 입력에 없던 항목은 입력하지 않음(null)이다. 해당 없음([])이나 다른 값으로 지어내지 않는다.
      profile: { ...NO_INPUT, businessStatus: 'PRE_STARTUP', districtCode: '11200' },
    });
    expect(pre.profile).not.toHaveProperty('industryCode');
    expect(pre.profile).not.toHaveProperty('purpose');

    const post = ok({ businessStage: 'POST_REGISTRATION', districtCode: null, industryCode: null, purpose: 'UNKNOWN' });
    expect(post.profile).toEqual({ ...NO_INPUT, businessStatus: 'BUSINESS' });
    // 사업자로 옮겨도 개업 연월은 모른다. 업력 조건은 확인 필요로 남는다(matching.ts의 INPUT_MISSING).
    expect(post.profile.openedYearMonth).toBeNull();

    expect(
      ok({ businessStage: 'UNKNOWN', districtCode: null, industryCode: null, purpose: 'UNKNOWN' }).profile,
    ).toEqual(NO_INPUT);
  });

  it('어느 모양에도 맞지 않으면 다른 값으로 해석하지 않고 INVALID다', () => {
    for (const value of [
      { businessStage: 'REGISTERED', districtCode: null, industryCode: null, purpose: 'UNKNOWN' },
      // 예전 조건도 서울 자치구 코드만 옮긴다.
      { businessStage: 'PRE_REGISTRATION', districtCode: '1120', industryCode: null, purpose: 'UNKNOWN' },
      { businessStage: 'PRE_REGISTRATION', districtCode: null, industryCode: null, purpose: 'UNKNOWN', extra: 1 },
      { ...FULL, age: 35.5 },
      { ...FULL, industryCode: 'CS100001' },
      'PRE_REGISTRATION',
      [],
    ]) {
      expect(readStoredFundingProfile(value).kind, JSON.stringify(value)).toBe('INVALID');
    }
  });
});

describe('자치구 정하기', () => {
  // ADR §4: 자금 조건의 자치구를 쓰고, 비어 있으면 계획의 사업 프로필(businessProfileJson.districtCode)을 쓴다.
  it('자금 조건의 자치구가 있으면 그것을 쓴다', () => {
    expect(withBusinessDistrict(FULL, { districtCode: '11200' })).toEqual({
      profile: FULL,
      districtSource: 'FUNDING_PROFILE',
    });
  });

  it('자금 조건의 자치구가 비어 있으면 사업 프로필의 자치구를 쓴다', () => {
    const profile = { ...FULL, districtCode: null };
    expect(withBusinessDistrict(profile, { districtCode: '11200', districtName: '성동구' })).toEqual({
      profile: { ...FULL, districtCode: '11200' },
      districtSource: 'BUSINESS_PROFILE',
    });
  });

  it('사업 프로필에도 서울 자치구가 없으면 비워 둔다', () => {
    const profile = { ...FULL, districtCode: null };
    for (const business of [null, undefined, {}, { districtCode: '41135' }, { districtCode: 11200 }, 'x']) {
      expect(withBusinessDistrict(profile, business), JSON.stringify(business)).toEqual({
        profile,
        districtSource: null,
      });
    }
  });
});
