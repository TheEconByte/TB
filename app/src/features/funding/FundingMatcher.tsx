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
        <p>
          사업자등록 여부·개업 연월·자치구·나이·대상 한정을 입력하면, AI가 공고문에서 읽어 둔 조건과 항목마다 맞춰 보고
          정책자금·지원사업으로 나눠 보여 줍니다. 항목마다 공고문 인용을 함께 보여 주며, 신청 전에는 원 공고를 확인해야
          합니다.
        </p>
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
            자금 공고 맞춰 보기는 로그인한 사용자만 쓸 수 있습니다. <Link href="/">내 창업 계획</Link>에서 로그인한 뒤
            다시 열어 주세요.
          </p>
        </div>
      )}

      {!isPending && session && (
        <>
          <section className="notice-box" aria-labelledby="funding-limits">
            <h2 id="funding-limits">이 결과가 무엇이고 무엇이 아닌지</h2>
            <ul>
              <li>
                맞아 보임은 AI가 공고문에서 읽은 조건과 입력이 맞아 보인다는 뜻이며 선정이나 지원 결정이 아닙니다.
              </li>
              <li>
                AI가 잘못 읽을 수 있어 조건이 안 맞아 보이는 공고도 숨기지 않고 접어 둡니다. 마감은 출처·운영자
                기록으로만 정합니다.
              </li>
              <li>지원금·보증·공간·프로그램 지원은 대출 원금이나 월 상환액으로 바꾸지 않습니다.</li>
              <li>입력하지 않은 항목은 해당 없음으로 채우지 않고 확인 필요로 남깁니다. 입력은 AI에 보내지 않습니다.</li>
            </ul>
          </section>

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
              <p className="picker-note">
                판정 기준일은 서버의 한국 시간 오늘이며 요청에서 바꿀 수 없습니다. 입력은 저장하지 않습니다. 계획에
                저장하려면 내 창업 계획 화면의 자금 조건을 쓰세요.
              </p>
            </form>
          </section>

          <section className="market-results" aria-live="polite" aria-busy={loading}>
            {loading && (
              <p className="loading-state" role="status">
                활성 카탈로그의 공고를 맞춰 보는 중…
              </p>
            )}
            {!loading && error && <FundingMatchesErrorPanel error={error} />}
            {!loading && !error && !result && (
              <p className="empty-state">
                조건을 입력하고 공고 맞춰 보기를 누르면 갈래·그룹별 공고와 이유를 보여 줍니다.
              </p>
            )}
            {!loading && !error && result && <FundingMatchesPanel result={result} />}
          </section>
        </>
      )}

      <footer>TrendBench · 공식 출처 기반 자금 공고 · 내부 MVP · 공개 출시 준비 완료 상태가 아닙니다.</footer>
    </main>
  );
}
