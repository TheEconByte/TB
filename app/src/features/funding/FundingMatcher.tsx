'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
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
      }
    },
    [form],
  );

  return (
    <main>
      <header>
        <Link href="/" className="brand">
          TrendBench<span>창업 준비의 기준</span>
        </Link>
        <div className="account-actions">
          <Link className="link-button" href="/">
            내 창업 계획
          </Link>
          <Link className="link-button" href="/markets">
            상권 탐색
          </Link>
        </div>
      </header>

      <MarketGradeBanner
        onLoaded={(score) => {
          // 상권에서 넘어오면 비어 있는 자치구만 채운다(ADR 0009 §6의 ADR 0008 개정). 나머지는 사용자가 고른다.
          setForm((current) =>
            current.districtCode === '' ? { ...current, districtCode: score.area.districtCode } : current,
          );
        }}
      />

      <section className="hero funding-hero">
        <p className="eyebrow">자금 공고 맞춰 보기</p>
        <h1>
          공고문의 조건을,
          <br />내 조건과 나란히.
        </h1>
        <p>AI가 공고문에서 읽은 조건과 내 조건을 항목마다 맞춰 봅니다.</p>
      </section>

      {isPending && (
        <p className="loading-state" role="status">
          로그인 상태를 확인하고 있습니다.
        </p>
      )}

      {!isPending && !session && (
        <div className="empty-panel" role="status">
          <h2>로그인이 필요합니다.</h2>
          <p>
            <Link href="/">내 창업 계획</Link>에서 로그인한 뒤 다시 열어 주세요.
          </p>
        </div>
      )}

      {!isPending && session && (
        <>
          <details className="notice-box">
            <summary>결과를 읽는 법</summary>
            <ul>
              <li>남은 공고는 AI가 읽은 조건 중 안 맞는 것이 없다는 뜻이며, 선정을 뜻하지 않습니다.</li>
              <li>조건에 안 맞는 공고는 빼고 건수를 밝힙니다. 펼쳐서 다시 볼 수 있습니다.</li>
              <li>입력하지 않은 항목은 확인 필요로 남깁니다. 입력은 AI에 보내지 않습니다.</li>
            </ul>
          </details>

          <section className="picker" aria-labelledby="funding-picker">
            <h2 id="funding-picker">내 조건 입력</h2>
            <form onSubmit={submit}>
              <FundingProfileFields form={form} onChange={setForm} idPrefix="funding-page" />
              {formError && (
                <p className="inline-error" role="alert">
                  {formError}
                </p>
              )}
              <div className="button-row">
                <button type="submit" disabled={loading}>
                  {loading ? '맞춰 보는 중…' : '공고 맞춰 보기'}
                </button>
              </div>
              <p className="picker-note">입력은 저장되지 않습니다.</p>
            </form>
          </section>

          <section className="market-results" aria-live="polite" aria-busy={loading}>
            {loading && (
              <p className="loading-state" role="status">
                공고를 맞춰 보는 중…
              </p>
            )}
            {!loading && error && <FundingMatchesErrorPanel error={error} />}
            {!loading && !error && result && <FundingMatchesPanel result={result} />}
          </section>
        </>
      )}
    </main>
  );
}
