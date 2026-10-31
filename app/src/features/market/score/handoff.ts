// /markets의 [이 상권으로 재무 계획 시작]에서 /로 넘기는 상권 참조(ADR 0008). 점수·금액은 넘기지 않고,
// 받는 쪽이 점수 API에서 다시 읽고 저장할 때는 서버가 점수 릴리스에서 다시 확인한다.
// 로그인 화면을 거쳐도 남도록 URL과 sessionStorage에 함께 둔다.

export type MarketScoreHandoff = {
  areaType: string;
  areaCode: string;
  industryCode: string;
  releaseKey: string;
};

const STORAGE_KEY = 'trendbench.marketScoreHandoff';
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

// 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 URL만으로 동작한다.
export function storeHandoff(handoff: MarketScoreHandoff): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(handoff));
  } catch {
    /* URL에 남아 있다. */
  }
}

export function readHandoff(): MarketScoreHandoff | null {
  const fromUrl = handoffFromSearch(window.location.search);
  if (fromUrl) {
    storeHandoff(fromUrl);
    return fromUrl;
  }
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? parseHandoff(JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function clearHandoff(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 저장소가 없으면 지울 것도 없다. */
  }
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
