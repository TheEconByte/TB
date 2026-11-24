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
import {
  INDUSTRIES,
  INDUSTRY_CODES,
  OPEN_INDUSTRIES,
  OPEN_INDUSTRY_CODES,
  isIndustryCode,
  isOpenIndustryCode,
} from './industries.ts';
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

  it('열린 업종은 아직 한식과 커피·음료뿐이고 이름은 지금 화면 그대로다', () => {
    // 근거: PRODUCT.md "상위 업종은 한식(CS100001)과 커피·음료(CS100010)만 노출한다". 업종은 7단계에서 연다.
    // 업종을 고르는 화면은 "한식음식점", 상권·프랜차이즈 화면은 "한식"으로 보여 왔다.
    expect(OPEN_INDUSTRIES.map(({ code, name, shortName }) => ({ code, name, shortName }))).toEqual([
      { code: 'CS100001', name: '한식음식점', shortName: '한식' },
      { code: 'CS100010', name: '커피·음료', shortName: '커피·음료' },
    ]);
  });

  it('사업 조건은 요식업 업종 코드를 모두 받는다', () => {
    // ADR 0010 3단계. 고를 수 있는지는 활성 상권 릴리스가 정한다(resolve.test.ts).
    expect(businessProfileInputSchema.shape.marketIndustryCode.options).toEqual(INDUSTRY_CODES);
  });

  it('조회와 업종 선택은 열린 업종만 받는다', () => {
    // 열지 않은 업종을 받으면 적재되지 않은 업종의 빈 결과를 성공처럼 보인다(ADR 0010 Validation).
    expect(franchiseQuerySchema.shape.industryCode.options).toEqual(OPEN_INDUSTRY_CODES);
    expect(franchiseQuerySchema.shape.industryCode.safeParse('CS100002').success).toBe(false);
    expect(selectMarketIndustry(EMPTY_BUSINESS_PROFILE_FORM, 'CS100002').marketIndustryCode).toBe('');
    expect(selectMarketIndustry(EMPTY_BUSINESS_PROFILE_FORM, 'CS100010').marketIndustryCode).toBe('CS100010');
    expect(businessProfileFormFromStored({ marketIndustryCode: 'CS100002' }).marketIndustryCode).toBe('');
    expect(businessProfileFormFromStored({ marketIndustryCode: 'CS100010' }).marketIndustryCode).toBe('CS100010');
  });

  it('상권은 요식업 업종을 모두 적재하고, 그중 열린 업종만 내보인다', () => {
    // ADR 0010 5단계: 업종을 열 때 다시 적재하지 않도록 관측값은 열 개 모두 남긴다.
    expect(MARKET_INDUSTRIES.map((item) => item.code)).toEqual(INDUSTRY_CODES);
    expect(isServedMarketIndustry({ code: 'CS100001', isSupported: true })).toBe(true);
    // 관측값이 있어도 열지 않은 업종은 내보이지 않는다.
    expect(isServedMarketIndustry({ code: 'CS100002', isSupported: true })).toBe(false);
    // 열린 업종이어도 그 릴리스에 관측값이 없으면 내보이지 않는다.
    expect(isServedMarketIndustry({ code: 'CS100001', isSupported: false })).toBe(false);
  });

  it('목록 밖 코드는 업종이 아니다', () => {
    // 외식업 상위 업종은 CS100001~CS100010이다(ADR 0010). 그 밖의 코드는 형식이 같아도 받지 않는다.
    expect(isIndustryCode('CS100011')).toBe(false);
    expect(businessProfileInputSchema.shape.marketIndustryCode.safeParse('CS100011').success).toBe(false);
  });

  it('대응표는 열린 업종으로만 보낸다', () => {
    // 대응표를 넓히는 일은 6단계이고, 그 전에는 열지 않은 업종의 점포를 적재하지 않는다.
    for (const code of Object.values(INDUSTRY_MIDDLE_TO_MARKET)) expect(isOpenIndustryCode(code)).toBe(true);
    const semas = [
      { middleName: '한식', smallCode: 'I20107', smallName: '돼지고기 구이/찜' },
      { middleName: '비알코올 음료점업', smallCode: 'I21201', smallName: '카페' },
      { middleName: '일식', smallCode: 'I20301', smallName: '일식 회/초밥' },
    ].map(marketIndustryForSemas);
    expect(semas).toEqual(['CS100001', 'CS100010', null]);
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
