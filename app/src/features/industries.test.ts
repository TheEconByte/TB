import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { marketIndustryForSemas } from './business-directory/mapping.ts';
import {
  EMPTY_BUSINESS_PROFILE_FORM,
  businessProfileFormFromStored,
  selectMarketIndustry,
} from './business-profile/form.ts';
import { businessProfileInputSchema } from './business-profile/schema.ts';
import { franchiseQuerySchema } from './franchise/schema.ts';
import { INDUSTRY_MIDDLE_TO_MARKET } from './franchise/types.ts';
import { INDUSTRIES, INDUSTRY_CODES, OPEN_INDUSTRY_CODES, isIndustryCode } from './industries.ts';
import { MARKET_INDUSTRIES, isServedMarketIndustry } from './market/types.ts';

// ADR 0010: 업종 목록은 한 파일에서 정하고 모든 도메인이 그 목록을 쓴다.
describe('업종 목록', () => {
  it('목록은 서울시 외식업 상위 업종 열 개다', () => {
    // 근거: ADR 0010 "확인한 사실"(원자료 sales-2025.zip의 CS100001~CS100010)과 §1 범위 결정.
    // 이름은 원자료 이름이며 "-"는 지금 화면처럼 "·"로 쓴다.
    expect(INDUSTRIES.map(({ code, name }) => [code, name])).toEqual([
      ['CS100001', '한식음식점'],
      ['CS100002', '중식음식점'],
      ['CS100003', '일식음식점'],
      ['CS100004', '양식음식점'],
      ['CS100005', '제과점'],
      ['CS100006', '패스트푸드점'],
      ['CS100007', '치킨전문점'],
      ['CS100008', '분식전문점'],
      ['CS100009', '호프·간이주점'],
      ['CS100010', '커피·음료'],
    ]);
  });

  it('요식업 업종 열 개를 모두 열고, 표시명은 적재한 상권 릴리스의 이름 그대로다', () => {
    // 근거: ADR 0010 7단계. 상권·경쟁 점포·프랜차이즈 자료를 열 개 업종 모두 적재했고, 열 개를 한 번에 열기로
    // 정했다(사용자 결정 2026-11-24). 상권 화면은 적재 때 릴리스에 저장한 표시명을 쓰므로, shortName을 바꾸면
    // 다시 적재하기 전까지 상권 화면과 프랜차이즈 화면의 이름이 갈린다. 그래서 한식 외에는 원자료 이름을 그대로 둔다
    // (ACTIVE 상권 릴리스 seoul-market-2021q1-2026q2-ea78b0888796의 displayName, 사용자 결정 2026-11-24).
    expect(OPEN_INDUSTRY_CODES).toEqual(INDUSTRY_CODES);
    expect(INDUSTRIES.map(({ code, shortName }) => [code, shortName])).toEqual([
      ['CS100001', '한식'],
      ['CS100002', '중식음식점'],
      ['CS100003', '일식음식점'],
      ['CS100004', '양식음식점'],
      ['CS100005', '제과점'],
      ['CS100006', '패스트푸드점'],
      ['CS100007', '치킨전문점'],
      ['CS100008', '분식전문점'],
      ['CS100009', '호프·간이주점'],
      ['CS100010', '커피·음료'],
    ]);
  });

  it('사업 조건은 요식업 업종 코드를 모두 받는다', () => {
    // ADR 0010 3단계. 고를 수 있는지는 활성 상권 릴리스가 정한다(resolve.test.ts).
    expect(businessProfileInputSchema.shape.marketIndustryCode.options).toEqual(INDUSTRY_CODES);
  });

  it('조회와 업종 선택은 열린 업종을 받고 목록 밖 코드는 받지 않는다', () => {
    // 열지 않은 업종을 받으면 적재되지 않은 업종의 빈 결과를 성공처럼 보인다(ADR 0010 Validation).
    // 7단계에서 새로 연 업종(중식 CS100002)을 고를 수 있어야 한다.
    expect(franchiseQuerySchema.shape.industryCode.options).toEqual(OPEN_INDUSTRY_CODES);
    expect(franchiseQuerySchema.shape.industryCode.safeParse('CS100002').success).toBe(true);
    expect(franchiseQuerySchema.shape.industryCode.safeParse('CS100011').success).toBe(false);
    expect(selectMarketIndustry(EMPTY_BUSINESS_PROFILE_FORM, 'CS100002').marketIndustryCode).toBe('CS100002');
    expect(selectMarketIndustry(EMPTY_BUSINESS_PROFILE_FORM, 'CS100011').marketIndustryCode).toBe('');
    expect(businessProfileFormFromStored({ marketIndustryCode: 'CS100002' }).marketIndustryCode).toBe('CS100002');
    expect(businessProfileFormFromStored({ marketIndustryCode: 'CS100011' }).marketIndustryCode).toBe('');
  });

  it('상권은 요식업 업종을 모두 적재하고, 그중 열린 업종만 내보인다', () => {
    // ADR 0010 5단계: 업종을 열 때 다시 적재하지 않도록 관측값은 열 개 모두 남긴다.
    expect(MARKET_INDUSTRIES.map((item) => item.code)).toEqual(INDUSTRY_CODES);
    expect(isServedMarketIndustry({ code: 'CS100001', isSupported: true })).toBe(true);
    // 7단계에서 연 업종은 내보이고, 목록 밖 코드는 관측값이 있어도 내보이지 않는다.
    expect(isServedMarketIndustry({ code: 'CS100002', isSupported: true })).toBe(true);
    expect(isServedMarketIndustry({ code: 'CS300001', isSupported: true })).toBe(false);
    // 열린 업종이어도 그 릴리스에 관측값이 없으면 내보이지 않는다.
    expect(isServedMarketIndustry({ code: 'CS100001', isSupported: false })).toBe(false);
  });

  it('목록 밖 코드는 업종이 아니다', () => {
    // 외식업 상위 업종은 CS100001~CS100010이다(ADR 0010). 그 밖의 코드는 형식이 같아도 받지 않는다.
    expect(isIndustryCode('CS100011')).toBe(false);
    expect(businessProfileInputSchema.shape.marketIndustryCode.safeParse('CS100011').success).toBe(false);
  });

  it('경쟁 점포와 프랜차이즈 대응표가 요식업 업종 열 개에 모두 닿는다', () => {
    // ADR 0010 §1: 한 업종은 경쟁 점포·프랜차이즈가 준비됐을 때 연다. 대응표에 없는 업종은 열 수 없다.
    const semas = [
      ['I201', 'I20101'],
      ['I202', 'I20201'],
      ['I203', 'I20301'],
      ['I204', 'I20401'],
      ['I210', 'I21001'],
      ['I210', 'I21004'],
      ['I210', 'I21006'],
      ['I210', 'I21007'],
      ['I211', 'I21103'],
      ['I212', 'I21201'],
    ].map(([middleCode, smallCode]) => marketIndustryForSemas({ middleCode, smallCode }));
    expect(semas).toEqual(INDUSTRY_CODES);
    expect([...new Set(Object.values(INDUSTRY_MIDDLE_TO_MARKET))].sort()).toEqual(INDUSTRY_CODES);
  });

  it('업종 코드를 목록과 원천 대응표 밖에 따로 적지 않는다', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    // 원천 분류를 상위 업종으로 바꾸는 대응표는 코드를 값으로 적는다(ADR 0010 §2).
    const allowed = new Set([
      'features/industries.ts',
      'features/business-directory/mapping.ts',
      'features/franchise/types.ts',
    ]);
    const files = (readdirSync(root, { recursive: true }) as string[])
      .map((file) => file.split(sep).join('/'))
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.startsWith('generated/'));
    const offenders = files.filter(
      (file) => !allowed.has(file) && /['"`]CS\d{6}['"`]/.test(readFileSync(join(root, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
