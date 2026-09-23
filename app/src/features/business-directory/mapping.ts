const MEAT_TERMS = ['소고기', '돼지고기', '닭/오리', '곱창', '족발', '보쌈', '육류', '고기'];

export function marketIndustryForSemas(
  input: Readonly<{ middleName: string; smallCode: string; smallName: string }>,
): string | null {
  if (input.smallCode === 'I21201' || /커피|카페|다방/.test(input.smallName)) return 'CS100010';
  if (/한식/.test(input.middleName)) return 'CS100001';
  return null;
}

export function isMeatCategory(name: string): boolean {
  return MEAT_TERMS.some((term) => name.includes(term));
}
