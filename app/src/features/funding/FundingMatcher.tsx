'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import MarketGradeBanner from '@/features/market/score/MarketGradeBanner';
import FundingProfileFields from './FundingProfileFields.tsx';
import {
  FundingMatchesErrorPanel,
  FundingMatchesPanel,
  describeFundingError,
  type FundingLoadError,
} from './FundingMatchesPanel.tsx';
import type { FundingMatchesWithProfile } from './match-list.ts';
import { EMPTY_FUNDING_FORM, fundingFormPayload, type FundingProfileForm } from './profile-form.ts';

const NO_INPUT = {
  businessStatus: null,
  openedYearMonth: null,
  districtCode: null,
  age: null,
  targetGroups: null,
} as const;

// 페이지 단위 맞춰 보기(ADR 0009 §4). 입력은 저장하지 않고 이 요청에만 쓴다.
export default function FundingMatcher() {
  const { data: session, isPending } = authClient.useSession();
  const [form, setForm] = useState<FundingProfileForm>(EMPTY_FUNDING_FORM);
  const [result, setResult] = useState<FundingMatchesWithProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FundingLoadError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // 결과는 입력란 아래에 생겨 폰 폭에서는 화면 밖이다. 조회가 끝나면 결과로 옮겨 눌러도 아무 일이 없는 것처럼 보이지 않게 한다.
  const resultsRef = useRef<HTMLElement>(null);
  const [searched, setSearched] = useState(0);
  useEffect(() => {
    if (searched > 0) resultsRef.current?.focus();
  }, [searched]);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const payload = fundingFormPayload(form);
      if (payload.kind === 'INVALID') {
        setFormError(payload.issue);
        return;
      }
      setFormError(null);
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/funding/candidates', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          // 아무것도 입력하지 않아도 맞춰 볼 수 있다. 조건을 정하지 않은 공고와 입력 없이 정해지는 항목만 맞음이 된다.
          body: JSON.stringify(payload.kind === 'OK' ? payload.profile : NO_INPUT),
        });
        const body = (await response.json().catch(() => null)) as
          FundingMatchesWithProfile | { error?: { code?: string; message?: string } } | null;
        if (!response.ok) {
          const apiError = body as { error?: { code?: string; message?: string } } | null;
          const failure = new Error(apiError?.error?.message ?? '요청을 처리하지 못했습니다.') as Error & {
            code?: string;
          };
          failure.code = apiError?.error?.code;
          throw failure;
        }
        setResult(body as FundingMatchesWithProfile);
      } catch (caught) {
        setResult(null);
        setError(describeFundingError(caught));
      } finally {
        setLoading(false);
        setSearched((count) => count + 1);
      }
    },
    [form],
  );

  return (
    <main>
      <MarketGradeBanner
        onLoaded={(score) => {
          // 상권에서 넘어오면 비어 있는 자치구만 채운다(ADR 0009 §6의 ADR 0008 개정). 나머지는 사용자가 고른다.
          setForm((current) =>
            current.districtCode === '' ? { ...current, districtCode: score.area.districtCode } : current,
          );
        }}
      />

      <div className="page-head">
        <h1>자금 공고</h1>
        <p>정책자금·지원사업 공고 중 내 조건과 안 맞는 것을 걸러 냅니다. 공고 조건은 AI가 공고문에서 읽은 것입니다.</p>
      </div>

      {isPending && (
        <p className="loading-state" role="status">
          로그인 상태를 확인하고 있습니다.
        </p>
      )}

      {!isPending && !session && (
        <div className="empty-panel" role="status">
          <h2>로그인이 필요합니다.</h2>
          <p>
            <Link href="/plans">로그인</Link>한 뒤 다시 열어 주세요.
          </p>
        </div>
      )}

      {!isPending && session && (
        <div className="split-layout">
          {/* 조건 입력이 먼저다. 걸러 내는 기준은 그 아래에 접어 둔다. */}
          <div className="split-aside">
            <section className="panel picker" aria-labelledby="funding-picker">
              <h2 id="funding-picker">내 조건</h2>
              <form onSubmit={submit}>
                <FundingProfileFields form={form} onChange={setForm} idPrefix="funding-page" />
                {formError && (
                  <p className="inline-error" role="alert">
                    {formError}
                  </p>
                )}
                <button type="submit" className="button primary" disabled={loading}>
                  {loading ? '찾는 중…' : '공고 찾기'}
                </button>
                <p className="note">입력은 저장되지 않습니다.</p>
              </form>
            </section>

            <details className="panel">
              <summary>걸러 내는 기준</summary>
              <ul className="note">
                <li>AI가 읽은 조건 중 하나라도 안 맞으면 뺍니다. 뺀 공고는 아래에서 펼쳐 볼 수 있습니다.</li>
                <li>입력하지 않은 항목은 &lsquo;확인 필요&rsquo;로 둡니다. 입력값은 AI에 보내지 않습니다.</li>
              </ul>
            </details>
          </div>

          <section
            ref={resultsRef}
            tabIndex={-1}
            className="split-main funding-results"
            aria-label="공고 찾기 결과"
            aria-live="polite"
            aria-busy={loading}
          >
            {loading && (
              <p className="loading-state" role="status">
                공고를 찾는 중…
              </p>
            )}
            {!loading && error && <FundingMatchesErrorPanel error={error} />}
            {!loading && !error && result && <FundingMatchesPanel result={result} />}
            {!loading && !error && !result && (
              <div className="empty-panel">
                <h2>찾은 공고가 여기에 나옵니다</h2>
                <p>조건을 고르고 [공고 찾기]를 누르면 여기에 공고가 나옵니다. 조건을 비워 둬도 찾을 수 있습니다.</p>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
