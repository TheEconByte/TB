// 화면이 계획 API를 부를 때 쓰는 요청 함수와 응답 모양. 계획 화면(/plans)과 홈(/)의 최근 계획이 함께 쓴다.
import type { FinanceInput, FinanceResult } from '@/features/finance/types';

export type PlanSummary = {
  id: string;
  title: string;
  revision: number;
  updatedAt: string;
  _count: { results: number };
};
export type ResultSummary = { id: string; inputRevision: number; calculationVersion: string; calculatedAt: string };
export type PlanDetail = {
  id: string;
  title: string;
  revision: number;
  inputJson: FinanceInput;
  fundingProfileJson: unknown;
  businessProfileJson: unknown;
  loanAssumptionJson?: unknown;
  marketScoreJson?: unknown;
  // 최근 계산한 결과가 먼저 온다.
  results: ResultSummary[];
};
export type StoredResult = {
  id: string;
  inputRevision: number;
  resultJson: FinanceResult;
  loanAssumptionJson?: unknown;
};

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? '요청을 처리하지 못했습니다.') as Error & { code?: string };
    error.code = body?.error?.code;
    throw error;
  }
  return body as T;
}
