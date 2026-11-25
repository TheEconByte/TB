// 홈(/)의 [열기]가 /plans에 어떤 계획을 열지 넘기는 주소. 계획 id만 넘기고, 소유자 검사는 계획 API가 한다.
// 받는 쪽은 한 번 읽으면 지운다. 남기면 새로고침할 때마다 목록에서 고른 계획 대신 이 계획이 다시 열린다.

const PLAN_PARAM = 'plan';

export function planHref(planId: string): string {
  return `/plans?${new URLSearchParams({ [PLAN_PARAM]: planId }).toString()}`;
}

export function planIdFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(PLAN_PARAM);
  return value ? value : null;
}

export function clearPlanParam(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PLAN_PARAM)) return;
  url.searchParams.delete(PLAN_PARAM);
  window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
