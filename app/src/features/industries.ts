// 제품이 다루는 서울시 상권분석서비스 외식업 상위 업종(ADR 0010). 상권·생존점수·경쟁 점포·
// 프랜차이즈·사업 조건이 모두 이 목록을 쓴다. 업종을 열 때는 이 목록에 한 줄을 더한다.
// name은 업종을 고르는 화면의 이름, shortName은 상권·프랜차이즈 화면의 표시명이다.
export const INDUSTRIES = [
  { code: 'CS100001', name: '한식음식점', shortName: '한식' },
  { code: 'CS100010', name: '커피·음료', shortName: '커피·음료' },
] as const;

export type Industry = (typeof INDUSTRIES)[number];
export type IndustryCode = Industry['code'];

export const INDUSTRY_CODES = INDUSTRIES.map((industry) => industry.code) as [IndustryCode, ...IndustryCode[]];

export function isIndustryCode(value: unknown): value is IndustryCode {
  return (INDUSTRY_CODES as readonly unknown[]).includes(value);
}

export function industryByCode(code: string): Industry | null {
  return INDUSTRIES.find((industry) => industry.code === code) ?? null;
}
