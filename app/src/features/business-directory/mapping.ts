import type { IndustryCode } from '../industries.ts';

// 소진공 상가업소 분류 → 서울시 상위 업종(ADR 0010 6단계). 서울시 업종은 표준산업분류(KSIC) 세세분류로
// 정의되어 있어(상권분석서비스 「100대 생활밀접업종 선정현황」) 그 정의에 맞춘다. 어느 표에도 없는 분류는
// 적재하지 않는다. 중분류 전체가 한 업종이면 중분류로 적어, 그 안에 새 소분류가 생겨도 같은 업종으로 본다.
const MIDDLE_TO_MARKET: Readonly<Record<string, IndustryCode>> = {
  I201: 'CS100001', // 한식
  I202: 'CS100002', // 중식
  I203: 'CS100003', // 일식
  I204: 'CS100004', // 서양식
  I205: 'CS100004', // 동남아시아: 기타 외국식(56129)은 양식음식점이다
  I206: 'CS100004', // 기타 외국
  I212: 'CS100010', // 비알코올
};

// 업종이 나뉘는 중분류(기타 간이 I210, 주점 I211)는 소분류마다 정한다. 구내식당·뷔페(I207), 아이스크림/빙수,
// 그 외 기타 간이 음식점, 유흥 주점은 열 개 업종에 맞지 않아 넣지 않는다.
const SMALL_TO_MARKET: Readonly<Record<string, IndustryCode>> = {
  I21001: 'CS100005', // 빵/도넛
  I21002: 'CS100005', // 떡/한과: 제과점업(56191)의 예시에 떡 전문점이 있다
  I21003: 'CS100006', // 피자
  I21004: 'CS100006', // 버거
  I21005: 'CS100006', // 토스트/샌드위치/샐러드
  I21006: 'CS100007', // 치킨
  I21007: 'CS100008', // 김밥/만두/분식
  I21103: 'CS100009', // 생맥주 전문
  I21104: 'CS100009', // 요리 주점
};

const MEAT_TERMS = ['소고기', '돼지고기', '닭/오리', '곱창', '족발', '보쌈', '육류', '고기'];

export function marketIndustryForSemas(
  input: Readonly<{ middleCode: string; smallCode: string }>,
): IndustryCode | null {
  return MIDDLE_TO_MARKET[input.middleCode] ?? SMALL_TO_MARKET[input.smallCode] ?? null;
}

export function isMeatCategory(name: string): boolean {
  return MEAT_TERMS.some((term) => name.includes(term));
}
