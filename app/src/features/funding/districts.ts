// 서울 25개 자치구의 행정표준코드. 상권 데이터의 자치구 코드와 같은 5자리
// 체계이므로 사용자가 고른 자치구를 그대로 상품의 지역 조건과 비교할 수 있다.
// 표시명으로 결합하지 않고 이 코드로 판정한다.
export type SeoulDistrict = { code: string; name: string };

export const SEOUL_DISTRICTS: readonly SeoulDistrict[] = [
  { code: '11110', name: '종로구' },
  { code: '11140', name: '중구' },
  { code: '11170', name: '용산구' },
  { code: '11200', name: '성동구' },
  { code: '11215', name: '광진구' },
  { code: '11230', name: '동대문구' },
  { code: '11260', name: '중랑구' },
  { code: '11290', name: '성북구' },
  { code: '11305', name: '강북구' },
  { code: '11320', name: '도봉구' },
  { code: '11350', name: '노원구' },
  { code: '11380', name: '은평구' },
  { code: '11410', name: '서대문구' },
  { code: '11440', name: '마포구' },
  { code: '11470', name: '양천구' },
  { code: '11500', name: '강서구' },
  { code: '11530', name: '구로구' },
  { code: '11545', name: '금천구' },
  { code: '11560', name: '영등포구' },
  { code: '11590', name: '동작구' },
  { code: '11620', name: '관악구' },
  { code: '11650', name: '서초구' },
  { code: '11680', name: '강남구' },
  { code: '11710', name: '송파구' },
  { code: '11740', name: '강동구' },
];

export function districtName(code: string | null): string | null {
  if (code === null) return null;
  return SEOUL_DISTRICTS.find((district) => district.code === code)?.name ?? code;
}
