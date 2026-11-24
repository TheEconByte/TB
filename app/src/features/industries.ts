// 제품이 다루는 서울시 상권분석서비스 외식업 상위 업종(ADR 0010). 상권·생존점수·경쟁 점포·
// 프랜차이즈·사업 조건이 모두 이 목록을 쓴다.
// name은 원자료 이름("-"는 "·"로 씀)이며 업종을 고르는 화면에 쓰고, shortName은 상권·프랜차이즈 화면의
// 표시명이다. open은 상권·경쟁 점포·프랜차이즈 자료가 모두 준비되어 사용자가 고를 수 있는 업종이고, 지금은 열 개
// 모두 열려 있다(ADR 0010 7단계). 열린 업종의 자료가 빠진 릴리스는 활성화하지 않는다.
// 상권 릴리스는 적재할 때 shortName을 표시명으로 저장하므로, shortName을 바꾸면 상권을 다시 적재해야 화면끼리 이름이 같다.
export const INDUSTRIES = [
  { code: 'CS100001', name: '한식음식점', shortName: '한식', open: true },
  { code: 'CS100002', name: '중식음식점', shortName: '중식음식점', open: true },
  { code: 'CS100003', name: '일식음식점', shortName: '일식음식점', open: true },
  { code: 'CS100004', name: '양식음식점', shortName: '양식음식점', open: true },
  { code: 'CS100005', name: '제과점', shortName: '제과점', open: true },
  { code: 'CS100006', name: '패스트푸드점', shortName: '패스트푸드점', open: true },
  { code: 'CS100007', name: '치킨전문점', shortName: '치킨전문점', open: true },
  { code: 'CS100008', name: '분식전문점', shortName: '분식전문점', open: true },
  { code: 'CS100009', name: '호프·간이주점', shortName: '호프·간이주점', open: true },
  { code: 'CS100010', name: '커피·음료', shortName: '커피·음료', open: true },
] as const;

export type Industry = (typeof INDUSTRIES)[number];
export type IndustryCode = Industry['code'];
export type OpenIndustry = Extract<Industry, { open: true }>;
export type OpenIndustryCode = OpenIndustry['code'];

export const INDUSTRY_CODES = INDUSTRIES.map((industry) => industry.code) as [IndustryCode, ...IndustryCode[]];

export const OPEN_INDUSTRIES = INDUSTRIES.filter((industry): industry is OpenIndustry => industry.open);
export const OPEN_INDUSTRY_CODES = OPEN_INDUSTRIES.map((industry) => industry.code) as [
  OpenIndustryCode,
  ...OpenIndustryCode[],
];

export function isIndustryCode(value: unknown): value is IndustryCode {
  return (INDUSTRY_CODES as readonly unknown[]).includes(value);
}

export function isOpenIndustryCode(value: unknown): value is OpenIndustryCode {
  return (OPEN_INDUSTRY_CODES as readonly unknown[]).includes(value);
}

export function industryByCode(code: string): Industry | null {
  return INDUSTRIES.find((industry) => industry.code === code) ?? null;
}
