'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ReportNav from '@/components/ReportNav';
import { authClient } from '@/lib/auth-client';
import type { FundingCandidatesResponse } from './candidates.ts';
import { SEOUL_DISTRICTS, districtName } from './districts.ts';
import { industryCodeIssue, purposeLabel, stageLabel, type FundingProfile } from './eligibility.ts';
import {
  FundingCandidatesErrorPanel,
  describeFundingError,
  formatFundingDate,
  fundingProfileSummary,
  type FundingLoadError,
} from './FundingCandidatesPanel.tsx';
import FundingReport from './FundingReport.tsx';
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

  // 제목·조건 칩은 입력 중인 값이 아니라 판정에 실제로 쓴 조건(result.profile)을 따른다.
  const profile: FundingProfile | null = result?.profile ?? null;
  const industryName = (code: string) => industries.find((industry) => industry.code === code)?.displayName ?? code;
  const industryLabel = profile?.industryCode ? industryName(profile.industryCode) : null;
  const districtLabel = profile?.districtCode ? (districtName(profile.districtCode) ?? profile.districtCode) : null;
  const profileSummary = useMemo(() => (profile ? fundingProfileSummary(profile) : ''), [profile]);

  return (
    <>
      <ReportNav active="funding" meta={result ? `판정 기준일 ${formatFundingDate(result.asOfDate)}` : null} />
      <main className="report-page">
        <section className="report-head">
          <p className="report-notice">
            <span className="report-tag">
              {result ? `카탈로그 ${result.release.catalogVersion}` : '공식 공고 기준'}
            </span>
            금리·한도는 운영자가 정리한 공고 요약이며 바뀔 수 있어요. 신청 전 기관 공고를 꼭 확인하세요.
          </p>
          <h1>
            {profile ? (
              <>
                서울시{districtLabel ? ` ${districtLabel}` : ''}
                {industryLabel ? (
                  <>
                    {' '}
                    <em>{industryLabel}</em>
                  </>
                ) : null}{' '}
                창업 정책자금 추천 보고서
              </>
            ) : (
              '정책자금 추천 보고서'
            )}
          </h1>
          {profile ? (
            <ul className="report-chips" aria-label="판정에 쓴 조건">
              <li>
                <span>지역</span>
                {districtLabel ? `서울시 ${districtLabel}` : '미입력'}
              </li>
              <li>
                <span>업종</span>
                {industryLabel ?? '미입력'}
              </li>
              <li>
                <span>단계</span>
                {profile.businessStage === 'UNKNOWN' ? '미입력' : stageLabel(profile.businessStage)}
              </li>
              <li>
                <span>용도</span>
                {profile.purpose === 'UNKNOWN' ? '미입력' : purposeLabel(profile.purpose)}
              </li>
            </ul>
          ) : (
            <p className="report-lead">
              조건을 고르면 활성 자금 카탈로그로 검토 후보·조건 확인·제외를 이유와 함께 정리해요. 검토 후보는 승인
              확정이 아니에요.
            </p>
          )}
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
            <section className="picker report-picker" aria-labelledby="funding-picker">
              <h2 id="funding-picker">조건 선택</h2>
              <form onSubmit={submit}>
                <div className="select-row market-select-row">
                  <label className="field">
                    <span>사업 단계</span>
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
                    <span>사업장·거주 자치구</span>
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
                    <span>업종 코드 (선택)</span>
                    <span className="input-wrap">
                      <input
                        className="text-input"
                        list="funding-industry-options"
                        value={industryCode}
                        placeholder="예: CS100010"
                        onChange={(event) => setIndustryCode(event.target.value)}
                      />
                    </span>
                    <small>상권 분석과 같은 업종 코드예요. 비워 두면 업종 조건은 미확인으로 남아요.</small>
                  </label>
                  <label className="field">
                    <span>자금 용도</span>
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
                <div className="picker-actions">
                  <p className="picker-note">
                    판정 기준일은 서버의 한국 시간 오늘이며 바꿀 수 없어요. 입력하지 않은 값은 0이 아니라 미확인으로
                    남아요.
                  </p>
                  <button type="submit" disabled={loading}>
                    {loading ? '조회 중…' : result ? '다시 조회' : '보고서 만들기'}
                  </button>
                </div>
              </form>
            </section>

            <div className="report-results" aria-live="polite" aria-busy={loading}>
              {loading && (
                <p className="loading-state" role="status">
                  활성 카탈로그를 기준으로 후보를 판정하는 중…
                </p>
              )}
              {!loading && error && <FundingCandidatesErrorPanel error={error} />}
              {!loading && !error && !result && (
                <p className="empty-state">조건을 고르고 보고서 만들기를 누르면 상태별 자금과 이유를 표시합니다.</p>
              )}
              {!loading && !error && result && (
                <FundingReport result={result} industryLabel={industryLabel} profileSummary={profileSummary} />
              )}
            </div>

            <section className="notice-box report-limits" aria-labelledby="funding-limits">
              <h2 id="funding-limits">이 결과가 무엇이고 무엇이 아닌지</h2>
              <ul>
                <li>검토 후보는 확인된 조건을 충족했다는 뜻이며 선정·승인이 확정된 것이 아닙니다.</li>
                <li>지원금·보증·공간·프로그램 지원은 대출 원금이나 월 상환액으로 바꾸지 않습니다.</li>
                <li>접수 상태(접수 중·종료·미확인)는 자격 판정과 별개로 저장된 관측값입니다.</li>
                <li>한도·금리·상환 조건 문장은 공고 요약이며, 확정 숫자로 기록된 금리만 비교합니다.</li>
                <li>입력하지 않은 값은 0으로 채우지 않고 미확인(UNKNOWN)으로 남깁니다.</li>
              </ul>
            </section>
          </>
        )}

        <footer>TrendBench · 공식 공고 기반 자금 카탈로그 · 내부 MVP · 공개 출시 준비 완료 상태가 아닙니다.</footer>
      </main>
    </>
  );
}
