// /markets의 [이 상권으로 재무 계획 시작]에서 /로 넘기는 상권 참조(ADR 0008). 점수·금액은 넘기지 않고,
// 받는 쪽이 점수 API에서 다시 읽고 저장할 때는 서버가 점수 릴리스에서 다시 확인한다.
// 참조는 URL에만 둔다. 이메일 로그인은 페이지를 옮기지 않아 로그인 화면을 거쳐도 URL이 남는다.
// 받는 쪽은 한 번 읽으면 지운다. 브라우저 저장소에 두면 떠났다가 일반 링크로 돌아와도 다시 채워진다.

export type MarketScoreHandoff = {
  areaType: string;
  areaCode: string;
  industryCode: string;
  releaseKey: string;
};

const PARAMS = {
  areaType: 'scoreAreaType',
  areaCode: 'scoreArea',
  industryCode: 'scoreIndustry',
  releaseKey: 'scoreRelease',
};

const PATTERNS: Record<keyof MarketScoreHandoff, RegExp> = {
  areaType: /^[A-Z]{1,4}$/,
  areaCode: /^\d{7}$/,
  industryCode: /^CS\d{6}$/,
  releaseKey: /^[a-z0-9-]{1,120}$/,
};

export function parseHandoff(value: Partial<Record<keyof MarketScoreHandoff, unknown>>): MarketScoreHandoff | null {
  const result = {} as MarketScoreHandoff;
  for (const key of Object.keys(PATTERNS) as (keyof MarketScoreHandoff)[]) {
    const item = value[key];
    if (typeof item !== 'string' || !PATTERNS[key].test(item)) return null;
    result[key] = item;
  }
  return result;
}

export function handoffSearch(handoff: MarketScoreHandoff): string {
  const params = new URLSearchParams();
  for (const key of Object.keys(PARAMS) as (keyof MarketScoreHandoff)[]) params.set(PARAMS[key], handoff[key]);
  return `?${params.toString()}`;
}

export function handoffFromSearch(search: string): MarketScoreHandoff | null {
  const params = new URLSearchParams(search);
  return parseHandoff({
    areaType: params.get(PARAMS.areaType),
    areaCode: params.get(PARAMS.areaCode),
    industryCode: params.get(PARAMS.industryCode),
    releaseKey: params.get(PARAMS.releaseKey),
  });
}

export function scoreApiUrl(handoff: Pick<MarketScoreHandoff, 'areaType' | 'areaCode' | 'industryCode'>): string {
  return `/api/markets/score?areaType=${encodeURIComponent(handoff.areaType)}&areaCode=${encodeURIComponent(handoff.areaCode)}&industryCode=${encodeURIComponent(handoff.industryCode)}`;
}

// 받은 참조를 URL에서 지운다. 다른 쿼리와 해시는 그대로 둔다.
export function clearHandoff(): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const name of Object.values(PARAMS)) {
    if (url.searchParams.has(name)) {
      url.searchParams.delete(name);
      changed = true;
    }
  }
  if (changed) window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
