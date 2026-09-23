'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import type { FundingCandidatesResponse } from './candidates.ts';
import { SEOUL_DISTRICTS } from './districts.ts';
import { industryCodeIssue, purposeLabel, stageLabel } from './eligibility.ts';
import {
  FundingCandidatesErrorPanel,
  FundingCandidatesPanel,
  describeFundingError,
  fundingProfileSummary,
  type FundingLoadError,
} from './FundingCandidatesPanel.tsx';
import { PURPOSES, type BusinessStage, type Purpose } from './types.ts';

type IndustryOption = { code: string; displayName: string };

export default function FundingMatcher() {
  const { data: session, isPending } = authClient.useSession();
  const [businessStage, setBusinessStage] = useState<BusinessStage | 'UNKNOWN'>('UNKNOWN');
  const [districtCode, setDistrictCode] = useState('');
  const [industryCode, setIndustryCode] = useState('');
  const [purpose, setPurpose] = useState<Purpose | 'UNKNOWN'>('UNKNOWN');
  const [industries, setIndustries] = useState<IndustryOption[]>([]);
  const [result, setResult] = useState<FundingCandidatesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<FundingLoadError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  // 업종 코드 제안은 선택 사항이다. 활성 상권 릴리스가 없으면 목록이 비어 있어도
  // 조회 자체를 막지 않는다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/industries', { headers: { accept: 'application/json' } });
        if (!response.ok) return;
        const body = (await response.json()) as { industries?: IndustryOption[] };
        if (!cancelled && Array.isArray(body.industries)) setIndustries(body.industries);
      } catch {
        // 제안 목록을 못 가져와도 직접 입력으로 조회할 수 있다.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmedIndustry = industryCode.trim().toUpperCase();
      const industryIssue = industryCodeIssue(industryCode);
      if (industryIssue) {
        setFormError(industryIssue);
        return;
      }
      setFormError(null);
      setLoading(true);
      setError(null);
      try {
        const response = await fetch('/api/funding/candidates', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            businessStage,
            districtCode: districtCode === '' ? null : districtCode,
            industryCode: trimmedIndustry === '' ? null : trimmedIndustry,
            purpose,
          }),
        });
        const body = (await response.json().catch(() => null)) as
          FundingCandidatesResponse | { error?: { code?: string; message?: string } } | null;
        if (!response.ok) {
          const apiError = body as { error?: { code?: string; message?: string } } | null;
          const failure = new Error(apiError?.error?.message ?? '요청을 처리하지 못했습니다.') as Error & {
            code?: string;
          };
          failure.code = apiError?.error?.code;
          throw failure;
        }
        setResult(body as FundingCandidatesResponse);
      } catch (caught) {
        setResult(null);
        setError(describeFundingError(caught));
      } finally {
        setLoading(false);
      }
    },
    [businessStage, districtCode, industryCode, purpose],
  );

  const profileSummary = useMemo(
    () =>
      fundingProfileSummary({
        businessStage,
        districtCode: districtCode === '' ? null : districtCode,
        industryCode: industryCode.trim() === '' ? null : industryCode.trim().toUpperCase(),
        purpose,
      }),
    [businessStage, districtCode, industryCode, purpose],
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

      <section className="hero funding-hero">
        <p className="eyebrow">자금 후보 조회</p>
        <h1>
          공식 공고만,
          <br />
          상태와 이유까지.
        </h1>
        <p>
          사업단계·자치구·업종·용도를 입력하면 활성 자금 카탈로그를 기준으로 검토 후보, 추가 확인, 등록 이후 검토, 종료,
          검수 만료, 미충족을 이유와 함께 보여줍니다. 후보가 0건이어도 정상 결과이며, 지원금·보증·공간 지원은 대출
          상환으로 계산하지 않습니다.
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
            자금 후보 조회는 로그인한 사용자만 사용할 수 있습니다. <Link href="/">내 창업 계획</Link>에서 로그인한 뒤
            다시 열어 주세요.
          </p>
        </div>
      )}

      {!isPending && session && (
        <>
          <section className="notice-box" aria-labelledby="funding-limits">
            <h2 id="funding-limits">이 결과가 무엇이고 무엇이 아닌지</h2>
            <ul>
              <li>검토 후보는 확인된 조건을 충족했다는 뜻이며 선정·승인이 확정된 것이 아닙니다.</li>
              <li>지원금·보증·공간·프로그램 지원은 대출 원금이나 월 상환액으로 바꾸지 않습니다.</li>
              <li>접수 상태(접수 중·종료·미확인)는 자격 판정과 별개로 저장된 관측값입니다.</li>
              <li>입력하지 않은 값은 0으로 채우지 않고 미확인(UNKNOWN)으로 남깁니다.</li>
            </ul>
          </section>

          <section className="picker" aria-labelledby="funding-picker">
            <h2 id="funding-picker">내 조건 입력</h2>
            <form onSubmit={submit}>
              <div className="select-row">
                <label className="field">
                  <span>1. 사업 단계</span>
                  <select
                    value={businessStage}
                    onChange={(event) => setBusinessStage(event.target.value as BusinessStage | 'UNKNOWN')}
                  >
                    <option value="UNKNOWN">아직 정하지 않음(미확인)</option>
                    {(['PRE_REGISTRATION', 'POST_REGISTRATION'] as const).map((stage) => (
                      <option key={stage} value={stage}>
                        {stageLabel(stage)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>2. 사업장·거주 자치구</span>
                  <select value={districtCode} onChange={(event) => setDistrictCode(event.target.value)}>
                    <option value="">선택하지 않음</option>
                    {SEOUL_DISTRICTS.map((district) => (
                      <option key={district.code} value={district.code}>
                        {district.name} ({district.code})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>3. 업종 코드 (선택)</span>
                  <span className="input-wrap">
                    <input
                      className="text-input"
                      list="funding-industry-options"
                      value={industryCode}
                      placeholder="예: CS100010"
                      onChange={(event) => setIndustryCode(event.target.value)}
                    />
                  </span>
                  <small>상권 탐색과 같은 업종 코드입니다. 비워두면 업종 조건은 미확인으로 남습니다.</small>
                </label>
                <label className="field">
                  <span>4. 자금 용도</span>
                  <select value={purpose} onChange={(event) => setPurpose(event.target.value as Purpose | 'UNKNOWN')}>
                    <option value="UNKNOWN">아직 정하지 않음(미확인)</option>
                    {PURPOSES.map((item) => (
                      <option key={item} value={item}>
                        {purposeLabel(item)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <datalist id="funding-industry-options">
                {industries.map((industry) => (
                  <option key={industry.code} value={industry.code}>
                    {industry.displayName}
                  </option>
                ))}
              </datalist>
              {formError && (
                <p className="inline-error" role="alert">
                  {formError}
                </p>
              )}
              <div className="button-row">
                <button type="submit" disabled={loading}>
                  {loading ? '조회 중…' : '후보 조회'}
                </button>
              </div>
              <p className="picker-note">
                판정 기준일은 서버의 한국 시간 오늘이며 요청에서 바꿀 수 없습니다. 업종 목록은 활성 상권 릴리스가 있을
                때만 제안되고, 없어도 코드를 직접 입력할 수 있습니다.
              </p>
            </form>
          </section>

          <section className="market-results" aria-live="polite" aria-busy={loading}>
            {loading && (
              <p className="loading-state" role="status">
                활성 카탈로그를 기준으로 후보를 판정하는 중…
              </p>
            )}
            {!loading && error && <FundingCandidatesErrorPanel error={error} />}
            {!loading && !error && !result && (
              <p className="empty-state">조건을 입력하고 후보 조회를 누르면 상태별 후보와 이유를 표시합니다.</p>
            )}
            {!loading && !error && result && <FundingCandidatesPanel result={result} profileSummary={profileSummary} />}
          </section>
        </>
      )}

      <footer>TrendBench · 공식 공고 기반 자금 카탈로그 · 내부 MVP · 공개 출시 준비 완료 상태가 아닙니다.</footer>
    </main>
  );
}
