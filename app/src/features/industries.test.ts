import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { marketIndustryForSemas } from './business-directory/mapping.ts';
import { businessProfileFormFromStored } from './business-profile/form.ts';
import { businessProfileInputSchema } from './business-profile/schema.ts';
import { franchiseQuerySchema } from './franchise/schema.ts';
import { INDUSTRY_MIDDLE_TO_MARKET } from './franchise/types.ts';
import { INDUSTRIES, INDUSTRY_CODES, isIndustryCode } from './industries.ts';
import { SUPPORTED_INDUSTRIES } from './market/types.ts';

// ADR 0010: 업종 목록은 한 파일에서 정하고 모든 도메인이 그 목록을 쓴다.
describe('업종 목록', () => {
  it('지금 다루는 업종은 한식과 커피·음료다', () => {
    // 근거: PRODUCT.md "상위 업종은 한식(CS100001)과 커피·음료(CS100010)만 노출한다".
    // ADR 0010 2단계는 목록을 모으기만 하고 업종을 열지 않는다.
    expect(INDUSTRY_CODES).toEqual(['CS100001', 'CS100010']);
  });

  it('업종 이름은 지금 화면의 이름 그대로다', () => {
    // 근거: 업종을 고르는 화면은 "한식음식점", 상권·프랜차이즈 화면은 "한식"으로 보여 왔다. 2단계는 화면을 바꾸지 않는다.
    expect(INDUSTRIES.map(({ code, name, shortName }) => ({ code, name, shortName }))).toEqual([
      { code: 'CS100001', name: '한식음식점', shortName: '한식' },
      { code: 'CS100010', name: '커피·음료', shortName: '커피·음료' },
    ]);
  });

  it('여러 도메인이 같은 목록을 받는다', () => {
    expect(businessProfileInputSchema.shape.marketIndustryCode.options).toEqual(INDUSTRY_CODES);
    expect(franchiseQuerySchema.shape.industryCode.options).toEqual(INDUSTRY_CODES);
    expect(SUPPORTED_INDUSTRIES.map((item) => item.code)).toEqual(INDUSTRY_CODES);
  });

  it('대응표는 목록 안의 업종으로만 보낸다', () => {
    for (const code of Object.values(INDUSTRY_MIDDLE_TO_MARKET)) expect(isIndustryCode(code)).toBe(true);
    const semas = [
      { middleName: '한식', smallCode: 'I20107', smallName: '돼지고기 구이/찜' },
      { middleName: '비알코올 음료점업', smallCode: 'I21201', smallName: '카페' },
      { middleName: '일식', smallCode: 'I20301', smallName: '일식 회/초밥' },
    ].map(marketIndustryForSemas);
    expect(semas.filter((code) => code !== null).every(isIndustryCode)).toBe(true);
  });

  it('목록 밖 업종은 받지 않는다', () => {
    // CS100002(중식음식점)는 서울시 외식업 상위 업종이지만 아직 열지 않았다(ADR 0010 §3).
    expect(isIndustryCode('CS100002')).toBe(false);
    expect(businessProfileInputSchema.shape.marketIndustryCode.safeParse('CS100002').success).toBe(false);
    expect(franchiseQuerySchema.shape.industryCode.safeParse('CS100002').success).toBe(false);
    expect(businessProfileFormFromStored({ marketIndustryCode: 'CS100002' }).marketIndustryCode).toBe('');
    expect(businessProfileFormFromStored({ marketIndustryCode: 'CS100010' }).marketIndustryCode).toBe('CS100010');
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
