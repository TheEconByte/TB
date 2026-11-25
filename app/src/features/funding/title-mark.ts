// 기업마당 공고 제목 맨 앞의 [..] 표시. 기업마당은 시·도가 낸 공고에 그 시·도를 [경남]처럼 붙인다.
// 수집기(서울 밖 공고 빼기)와 맞춰 보기(지역 항목의 확인 필요 이유)가 같은 판단을 쓴다(ADR 0009 §2·§4).
export function bizinfoTitleMark(title: string): string | null {
  return /^\s*\[([^\]]+)\]/.exec(title)?.[1].trim() ?? null;
}

// 표시에 서울도 전국도 없으면 서울 밖 지역을 밝힌 것으로 본다. [대구ㆍ경북]은 서울 밖이고, [서울ㆍ경기]·[전국]은 서울도 대상이다.
export function isOutsideSeoulMark(mark: string | null): mark is string {
  return mark !== null && !['서울', '전국'].some((name) => mark.includes(name));
}
