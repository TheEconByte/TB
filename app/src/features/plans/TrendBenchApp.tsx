'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import FinancePlanner, { type PlanStep } from '@/features/finance/FinancePlanner';
import { newPlanInput } from '@/features/finance/form';
import { quarterLabel } from '@/features/market/quarter';
import type { MarketScoreResponse } from '@/features/market/score/api';
import { clearHandoff, handoffFromSearch, scoreApiUrl, type MarketScoreHandoff } from '@/features/market/score/handoff';
import {
  CURRENT_MONTHLY_REVENUE_INTERPRETATION,
  interpretationDivisor,
  interpretationPhrase,
} from '@/features/market/score/revenue';
import { UnusualRevenueWarning } from '@/features/market/score/ScorePanel';
import { parsePlanMarketScore } from '@/features/plans/market-score';
import type { FinanceInput } from '@/features/finance/types';
import { api, type PlanDetail, type PlanSummary, type StoredResult } from '@/features/plans/client';
import { districtName } from '@/features/funding/districts';
import FundingProfileFields from '@/features/funding/FundingProfileFields';
import {
  FundingMatchesErrorPanel,
  FundingMatchesPanel,
  describeFundingError,
  type FundingLoadError,
} from '@/features/funding/FundingMatchesPanel';
import { readStoredFundingProfile, withBusinessDistrict } from '@/features/funding/match-profile';
import { fundingProfileSummary, type ViewedFundingGap } from '@/features/funding/match-text';
import type { FundingMatchProfile } from '@/features/funding/matching';
import {
  EMPTY_FUNDING_FORM,
  fundingFormFromProfile,
  fundingFormPayload,
  type FundingProfileForm,
} from '@/features/funding/profile-form';
import type { PlanFundingMatchesResponse } from '@/features/plans/funding-matches';
import { clearPlanParam, planIdFromSearch } from '@/features/plans/plan-link';
import { revisionLabel } from '@/lib/revision-text';
import {
  describeLoanAssumption,
  planLoanAssumptionSchema,
  type PlanLoanAssumption,
} from '@/features/plans/loan-assumption';
import SiteHeader from '@/components/SiteHeader';
import { authClient } from '@/lib/auth-client';
import BusinessProfileWizard from '@/features/business-profile/BusinessProfileWizard';
import {
  EMPTY_BUSINESS_PROFILE_FORM,
  businessProfileFormFromStored,
  businessProfileSaveState,
  type BusinessProfileForm,
} from '@/features/business-profile/form';
import FranchisePanel from '@/features/franchise/FranchisePanel';
import RentBenchmarkPanel from '@/features/rent-benchmark/RentBenchmarkPanel';

// 상권 탐색에서 넘어와 아직 저장하지 않은 새 계획의 출처.
type MarketSource = { handoff: MarketScoreHandoff; score: MarketScoreResponse };

const wonFormat = new Intl.NumberFormat('ko-KR');
const savedAtFormat = new Intl.DateTimeFormat('ko-KR', {
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const formatWon = (value: string) => `${wonFormat.format(BigInt(value))}원`;

// 자금 조건은 재무 입력과 별도로 저장한다(ADR 0009 §4). 입력란 상태와 본문 변환은 /funding과 같은 profile-form.ts를 쓴다.

// 저장된 자금 조건을 입력란으로 되돌린다. 예전 모양은 사업 단계·자치구만 옮긴다(match-profile.ts). 어느 모양에도 맞지
// 않으면 다른 값으로 해석하지 않고 빈 입력란으로 두며, 조회는 서버가 400으로 거부한다.
function fundingFormFromStored(value: unknown): FundingProfileForm {
  const stored = readStoredFundingProfile(value);
  return stored.kind === 'OK' ? fundingFormFromProfile(stored.profile) : EMPTY_FUNDING_FORM;
}

const isEmptyFundingForm = (form: FundingProfileForm) => fundingFormPayload(form).kind === 'EMPTY';

// 저장된 대출 가정의 출처를 화면에서 쓰는 값으로 되돌린다. 스키마와 맞지 않으면 임의로
// 해석하지 않고 출처 없음으로 둔다.
function parseLoanAssumption(value: unknown): PlanLoanAssumption | null {
  if (value === null || value === undefined) return null;
  const parsed = planLoanAssumptionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function AuthScreen() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const result =
      mode === 'signup'
        ? await authClient.signUp.email({ name, email, password })
        : await authClient.signIn.email({ email, password });
    setBusy(false);
    if (result.error)
      setMessage(
        mode === 'signin'
          ? '이메일 또는 비밀번호를 확인해 주세요.'
          : (result.error.message ?? '회원가입에 실패했습니다.'),
      );
  }
  return (
    <main>
      <SiteHeader />
      <section className="auth-shell">
        <div>
          <h1>재무 계획은 로그인해야 저장됩니다</h1>
          <p>계획과 계산 결과는 내 계정에만 남습니다. 비밀번호 찾기는 아직 없습니다.</p>
        </div>
        <form className="auth-card" onSubmit={submit}>
          <h2>{mode === 'signin' ? '로그인' : '회원가입'}</h2>
          {mode === 'signup' && (
            <label className="field">
              <span>이름</span>
              <span className="input-wrap">
                <input
                  className="text-input"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </span>
            </label>
          )}
          <label className="field">
            <span>이메일</span>
            <span className="input-wrap">
              <input
                className="text-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </span>
          </label>
          <label className="field">
            <span>비밀번호</span>
            <span className="input-wrap">
              <input
                className="text-input"
                type="password"
                minLength={8}
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </span>
            <small>8자 이상 입력해 주세요.</small>
          </label>
          {message && (
            <p className="inline-error" role="alert">
              {message}
            </p>
          )}
          <button disabled={busy}>{busy ? '처리 중…' : mode === 'signin' ? '로그인' : '회원가입'}</button>
          <button
            className="link-button"
            type="button"
            onClick={() => {
              setMode(mode === 'signin' ? 'signup' : 'signin');
              setMessage('');
            }}
          >
            {mode === 'signin' ? '계정이 없나요? 회원가입' : '이미 계정이 있나요? 로그인'}
          </button>
        </form>
      </section>
    </main>
  );
}

function AuthenticatedWorkspace({ email }: { email: string }) {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [plan, setPlan] = useState<PlanDetail | null>(null);
  const [storedResult, setStoredResult] = useState<StoredResult | null>(null);
  const [fundingForm, setFundingForm] = useState<FundingProfileForm>(EMPTY_FUNDING_FORM);
  const [businessForm, setBusinessForm] = useState<BusinessProfileForm>(EMPTY_BUSINESS_PROFILE_FORM);
  const [matches, setMatches] = useState<PlanFundingMatchesResponse | null>(null);
  const [matchesError, setMatchesError] = useState<FundingLoadError | null>(null);
  const [matchesLoading, setMatchesLoading] = useState(false);
  // 보고 있는 단계. 계획을 열면 결과가 있을 때 결과부터, 없으면 첫 단계부터 보여 준다.
  const [step, setStep] = useState<PlanStep>('business');
  // 마지막으로 저장하거나 연 계획의 id. 저장 직후의 공고 조회처럼 상태(plan)가 아직 바뀌기 전에 쓴다.
  const savedPlanId = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  // /markets의 [이 상권으로 재무 계획 시작]이 URL로 넘긴 상권 참조. 화면을 열 때 한 번만 읽는다.
  // next/link로 넘어오면 렌더링 중의 window.location은 아직 이전 화면 주소라 라우터의 검색 파라미터를 읽는다.
  const searchParams = useSearchParams();
  const [handoff] = useState(() => handoffFromSearch(searchParams.toString()));
  // 넘어온 상권. 새 계획을 저장하면 비운다.
  const [marketSource, setMarketSource] = useState<MarketSource | null>(null);
  // 점수를 읽는 동안에는 새 계획 재무 입력을 열지 않는다. 늦은 응답이 그사이 입력한 값을 덮지 않게 한다.
  const [marketLoading, setMarketLoading] = useState(handoff !== null);

  // 넘겨받은 참조로 점수 API를 다시 읽는다. URL 값을 그대로 믿지 않고, 저장할 때도 서버가 다시 확인한다.
  // 읽은 참조는 바로 URL에서 지운다. 버튼을 누른 그 한 번만 쓰고, 실패·새로고침·로그아웃 뒤에 다시 쓰지 않는다(ADR 0008 §5).
  useEffect(() => {
    if (!handoff) return;
    clearHandoff();
    let cancelled = false;
    void (async () => {
      try {
        const score = await api<MarketScoreResponse>(scoreApiUrl(handoff));
        if (cancelled) return;
        if (score.status !== 'OK' || !score.score || !score.financeDefault) {
          setMessage(score.message ?? '이 상권 점수는 재무 계획에 연결할 수 없습니다.');
          return;
        }
        setMarketSource({ handoff: { ...handoff, releaseKey: score.release.releaseKey }, score });
        setFundingForm((current) =>
          isEmptyFundingForm(current) ? { ...current, districtCode: score.area.districtCode } : current,
        );
        setMessage(
          `${score.area.displayName} ${score.industry.displayName} 상권 기준으로 자치구와 월매출을 채웠습니다. 고쳐도 됩니다.`,
        );
      } catch (error) {
        if (!cancelled) setMessage(error instanceof Error ? error.message : '상권 점수를 불러오지 못했습니다.');
      } finally {
        if (!cancelled) setMarketLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [handoff]);

  function disconnectMarketSource() {
    setMarketSource(null);
    setMessage('상권 연결을 끊었습니다. 채운 값은 그대로 남습니다.');
  }

  const refreshPlans = useCallback(async () => {
    const data = await api<{ plans: PlanSummary[] }>('/api/plans');
    setPlans(data.plans);
  }, []);
  const openPlan = useCallback(async (id: string) => {
    setBusy(true);
    setMessage('');
    try {
      const data = await api<{ plan: PlanDetail }>(`/api/plans/${encodeURIComponent(id)}`);
      setPlan(data.plan);
      savedPlanId.current = data.plan.id;
      setStoredResult(null);
      // 계획을 열면 저장된 자금 조건을 그대로 보여주고 이전 판정 결과는 지운다.
      setFundingForm(fundingFormFromStored(data.plan.fundingProfileJson));
      setMatches(null);
      setMatchesError(null);
      setBusinessForm(businessProfileFormFromStored(data.plan.businessProfileJson));
      // 계산한 계획은 결과부터 보여 준다. 돌아온 사용자가 먼저 묻는 것은 "결과가 어땠나"다.
      if (data.plan.results[0]) {
        const resultData = await api<{ result: StoredResult }>(`/api/plans/${id}/results/${data.plan.results[0].id}`);
        setStoredResult(resultData.result);
        setStep('result');
      } else {
        setStep('business');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '계획을 불러오지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void refreshPlans().catch((error) => setMessage(error.message)), 0);
    return () => window.clearTimeout(timer);
  }, [refreshPlans]);
  // 홈의 [열기]가 넘긴 계획을 연다. 없거나 남의 계획이면 API의 404 문구를 보이고 새 계획으로 둔다.
  const [linkedPlanId] = useState(() => planIdFromSearch(searchParams.toString()));
  useEffect(() => {
    if (!linkedPlanId) return;
    clearPlanParam();
    const timer = window.setTimeout(() => void openPlan(linkedPlanId), 0);
    return () => window.clearTimeout(timer);
  }, [linkedPlanId, openPlan]);

  async function saveDraft(title: string, input: FinanceInput) {
    // 자금 조건 형식(나이·개업 연월)은 서버에 보내기 전에 막는다. 형식이 틀리면 계획 저장 요청 전체가
    // 400으로 거부되어 재무 입력까지 함께 저장되지 않기 때문이다.
    const funding = fundingFormPayload(fundingForm);
    if (funding.kind === 'INVALID') {
      const fundingIssue = `자금 조건을 확인해 주세요: ${funding.issue}`;
      setMessage(fundingIssue);
      setStep('funding');
      requestAnimationFrame(() => document.querySelector('.status-message')?.scrollIntoView({ block: 'start' }));
      throw new Error(fundingIssue);
    }
    // 사업 조건을 일부만 입력한 채 저장하면 null이 가서 저장된 조건까지 지워진다. 저장 전에 막는다.
    const profileState = businessProfileSaveState(businessForm);
    if (profileState.kind === 'INCOMPLETE') {
      const profileIssue = `사업 조건이 덜 채워져 저장하지 않았습니다(빠진 항목: ${profileState.missing.join(', ')}). 다 채우거나 모두 비우세요.`;
      setMessage(profileIssue);
      setStep('business');
      requestAnimationFrame(() => document.querySelector('.status-message')?.scrollIntoView({ block: 'start' }));
      throw new Error(profileIssue);
    }
    setBusy(true);
    setMessage('');
    try {
      // 재무 입력과 저장된 자금 조건을 함께 보낸다. 서버는 계산 키·결과 스냅샷을
      // 건드리지 않고 조건만 따로 보존한다. 아무것도 입력하지 않으면 null을 보내 저장된 조건을 비운다
      // ("조건 없음"과 "모두 입력하지 않음"을 구분한다). 예전 모양으로 저장된 조건도 이때 지금 모양으로 쓴다.
      const fundingProfile: FundingMatchProfile | null = funding.kind === 'OK' ? funding.profile : null;
      const businessProfile = profileState.kind === 'COMPLETE' ? profileState.payload : null;
      const data = plan
        ? await api<{ plan: PlanDetail }>(`/api/plans/${plan.id}`, {
            method: 'PUT',
            body: JSON.stringify({ title, input, fundingProfile, businessProfile, revision: plan.revision }),
          })
        : await api<{ plan: PlanDetail }>('/api/plans', {
            method: 'POST',
            body: JSON.stringify({
              title,
              input,
              fundingProfile,
              businessProfile,
              // 상권에서 시작한 새 계획만 참조를 보낸다. 등급·기본값은 서버가 점수 릴리스에서 다시 읽는다.
              ...(marketSource ? { marketScore: marketSource.handoff } : {}),
            }),
          });
      if (!plan && marketSource) setMarketSource(null);
      setPlan({ ...data.plan, inputJson: input, results: plan?.results ?? [] });
      savedPlanId.current = data.plan.id;
      // revision이 올라가면 이전 판정은 다른 조건의 결과이므로 지운다.
      setMatches(null);
      setMatchesError(null);
      await refreshPlans();
      setMessage('초안을 저장했습니다.');
      return data.plan;
    } catch (error) {
      const typed = error as Error & { code?: string };
      setMessage(
        typed.code === 'REVISION_CONFLICT'
          ? '다른 창에서 이 계획이 먼저 수정됐습니다. 계획을 다시 열어 주세요.'
          : typed.message,
      );
      throw error;
    } finally {
      setBusy(false);
    }
  }
  async function calculate(title: string, input: FinanceInput) {
    const saved = await saveDraft(title, input);
    setBusy(true);
    setMessage('계산하고 있습니다.');
    try {
      const data = await api<{ result: StoredResult; reused: boolean }>(`/api/plans/${saved.id}/calculations`, {
        method: 'POST',
      });
      setStoredResult(data.result);
      // 계획 목록의 계산 횟수가 이 결과를 세도록 목록도 다시 읽는다.
      await Promise.all([openPlan(saved.id), refreshPlans()]);
      setStoredResult(data.result);
      setMessage(data.reused ? '이미 계산한 결과를 불러왔습니다.' : '계산 결과를 저장했습니다.');
      return data.result.resultJson;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '계산 결과를 저장하지 못했습니다.');
      throw error;
    } finally {
      setBusy(false);
    }
  }
  async function removePlan() {
    if (!plan || !window.confirm(`“${plan.title}” 계획과 저장 결과를 삭제할까요?`)) return;
    setBusy(true);
    try {
      await api(`/api/plans/${plan.id}`, { method: 'DELETE' });
      // 새 계획 화면과 같은 상태로 되돌린다. 자금 조건을 지우지 않으면 삭제한 계획의
      // 조건이 다음 계획에 그대로 저장된다.
      setPlan(null);
      savedPlanId.current = null;
      setStoredResult(null);
      setStep('business');
      setFundingForm(EMPTY_FUNDING_FORM);
      setBusinessForm(EMPTY_BUSINESS_PROFILE_FORM);
      setMatches(null);
      setMatchesError(null);
      await refreshPlans();
      setMessage('계획을 삭제했습니다.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '삭제하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }
  async function openResult(resultId: string) {
    if (!plan) return;
    const data = await api<{ result: StoredResult }>(`/api/plans/${plan.id}/results/${resultId}`);
    setStoredResult(data.result);
  }
  // 저장된 계획 조건으로만 판정한다. 요청 본문에 조건이나 기준일을 보내지 않는다. 그래서 화면의 조건을 먼저 저장하고 찾는다.
  async function saveAndQueryFunding(save: () => Promise<boolean>) {
    if (!(await save()) || !savedPlanId.current) return;
    await queryPlanFundingMatches(savedPlanId.current);
  }
  async function queryPlanFundingMatches(planId: string) {
    setMatchesLoading(true);
    setMatchesError(null);
    try {
      const data = await api<PlanFundingMatchesResponse>(`/api/plans/${planId}/funding-matches`, { method: 'POST' });
      setMatches(data);
    } catch (error) {
      setMatches(null);
      setMatchesError(describeFundingError(error));
    } finally {
      setMatchesLoading(false);
    }
  }

  const storedFunding = plan ? storedFundingState(plan) : null;
  // 보고 있는 저장 결과의 부족자금. 다시 계산하지 않는다.
  const viewedFundingGap: ViewedFundingGap = storedResult
    ? { revision: storedResult.inputRevision, value: storedResult.resultJson.plannedFundingGap }
    : null;
  const storedAssumption = plan ? parseLoanAssumption(plan.loanAssumptionJson) : null;
  const pendingMarket = plan === null ? marketSource : null;
  const storedMarketScore = plan ? parsePlanMarketScore(plan.marketScoreJson) : null;
  const resultAssumption = parseLoanAssumption(storedResult?.loanAssumptionJson);

  // 단계에 넣는 사업 조건·참고 자료·자금 공고. 참고 자료는 그 값을 넣는 단계 옆에 두고, 재무 입력에 자동으로 넣지 않는다.
  // 사업 조건의 마지막 단계에는 다음 버튼이 없다. 계획 단계 이동은 하단 막대의 [다음]이 맡는다.
  const businessStep = <BusinessProfileWizard form={businessForm} onChange={setBusinessForm} />;
  const businessDone = businessProfileSaveState(businessForm).kind === 'COMPLETE';
  // 개업 비용을 정할 때는 프랜차이즈 창업 금액을, 월 운영을 정할 때는 임대료 시세와 프랜차이즈 평균매출을 본다.
  const openingReference = (
    <FranchisePanel
      focus="startup"
      industryCode={businessForm.marketIndustryCode}
      savedMonthlyRevenue={plan?.inputJson.monthlyRevenue ?? null}
    />
  );
  const operatingReference = (
    <>
      <RentBenchmarkPanel profile={businessForm} savedMonthlyRent={plan?.inputJson.monthlyFixedCosts.rent ?? null} />
      <details className="reference-details">
        <summary>프랜차이즈 평균매출과 비교</summary>
        <FranchisePanel
          focus="revenue"
          industryCode={businessForm.marketIndustryCode}
          savedMonthlyRevenue={plan?.inputJson.monthlyRevenue ?? null}
        />
      </details>
    </>
  );
  // 자금 공고는 결과에서 대출 전 부족액을 본 뒤에 찾는다.
  const fundingStep = (save: () => Promise<boolean>) => (
    <>
      <PlanFundingFields
        form={fundingForm}
        onChange={setFundingForm}
        businessDistrict={businessForm.districtCode || null}
      />
      <PlanFundingPanel
        stored={storedFunding}
        hasCondition={!isEmptyFundingForm(fundingForm)}
        fundingGap={viewedFundingGap}
        loading={matchesLoading || busy}
        matches={matches}
        error={matchesError}
        onQuery={() => void saveAndQueryFunding(save)}
        appliedSummary={plan !== null && storedAssumption ? describeLoanAssumption(storedAssumption) : null}
      />
    </>
  );

  return (
    <main>
      <SiteHeader
        account={
          <>
            <span>{email}</span>
            <button className="link-button" onClick={() => void authClient.signOut()}>
              로그아웃
            </button>
          </>
        }
      />
      <div className="workspace">
        <aside className="plan-sidebar">
          <div className="sidebar-heading">
            <h2>내 계획</h2>
            <button
              onClick={() => {
                setPlan(null);
                savedPlanId.current = null;
                setStoredResult(null);
                setStep('business');
                // 상권에서 넘어온 연결이 남아 있으면 새 계획에 다시 미리 채운다.
                setFundingForm(
                  marketSource
                    ? { ...EMPTY_FUNDING_FORM, districtCode: marketSource.score.area.districtCode }
                    : EMPTY_FUNDING_FORM,
                );
                setBusinessForm(EMPTY_BUSINESS_PROFILE_FORM);
                setMatches(null);
                setMatchesError(null);
                setMessage('');
              }}
            >
              새 계획
            </button>
          </div>
          {plans.length === 0 ? (
            <p className="empty-state">저장한 계획이 없습니다.</p>
          ) : (
            <ul>
              {plans.map((item) => (
                <li key={item.id}>
                  <button className={plan?.id === item.id ? 'active' : ''} onClick={() => void openPlan(item.id)}>
                    <strong>{item.title}</strong>
                    <span>
                      {savedAtFormat.format(new Date(item.updatedAt))} 저장 · 계산 {item._count.results}회
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {plan && (
            <button className="danger-button" disabled={busy} onClick={() => void removePlan()}>
              이 계획 삭제
            </button>
          )}
        </aside>
        <div className="planner-column">
          {message && (
            <div className="status-message" role="status">
              {message}
            </div>
          )}
          {plan === null && marketLoading ? (
            <p className="loading-state" role="status">
              상권 점수를 불러오고 있습니다.
            </p>
          ) : (
            <FinancePlanner
              // 상권 연결 여부는 resetKey에 넣지 않는다. 연결을 해제할 때 입력을 되돌리면 저장하지 않은 입력이 사라진다.
              resetKey={plan?.id ?? 'new'}
              initialTitle={
                plan?.title ??
                (pendingMarket
                  ? `${pendingMarket.score.area.displayName} ${pendingMarket.score.industry.displayName} 계획`
                  : undefined)
              }
              initialInput={
                plan?.inputJson ??
                (pendingMarket?.score.financeDefault
                  ? newPlanInput({ monthlyRevenue: pendingMarket.score.financeDefault.monthlyRevenue })
                  : undefined)
              }
              initialResult={storedResult?.resultJson}
              resultInput={storedResult?.inputSnapshot}
              revision={plan?.revision ?? null}
              resultRevision={storedResult?.inputRevision ?? null}
              busy={busy}
              revenueNotice={
                <MarketSourceNotice
                  pending={pendingMarket}
                  stored={storedMarketScore}
                  onDisconnect={disconnectMarketSource}
                />
              }
              step={step}
              onStepChange={setStep}
              businessDone={businessDone}
              fundingDone={!isEmptyFundingForm(fundingForm)}
              businessStep={businessStep}
              openingReference={openingReference}
              operatingReference={operatingReference}
              fundingStep={fundingStep}
              resultHistory={
                plan &&
                plan.results.length > 0 && (
                  <>
                    <div className="result-history">
                      <strong>계산 기록</strong>
                      {plan.results.map((result) => (
                        <button
                          key={result.id}
                          className={storedResult?.id === result.id ? 'active' : ''}
                          onClick={() => void openResult(result.id)}
                        >
                          {revisionLabel(result.inputRevision)} ·{' '}
                          {new Date(result.calculatedAt).toLocaleString('ko-KR')}
                        </button>
                      ))}
                    </div>
                    {resultAssumption && (
                      <p className="funding-position">
                        이 결과에 쓴 대출 가정: {describeLoanAssumption(resultAssumption)}
                      </p>
                    )}
                  </>
                )
              }
              onSave={saveDraft}
              onCalculate={calculate}
            />
          )}
        </div>
      </div>
    </main>
  );
}

// 월매출 입력란 위의 출처. 새 계획이면 넘어온 상권 점수, 저장된 계획이면 저장 당시 스냅샷을 보여 준다.
function MarketSourceNotice({
  pending,
  stored,
  onDisconnect,
}: {
  readonly pending: MarketSource | null;
  readonly stored: ReturnType<typeof parsePlanMarketScore>;
  readonly onDisconnect: () => void;
}) {
  if (pending?.score.score && pending.score.financeDefault) {
    const { score } = pending;
    return (
      <div className="market-source" role="note" data-testid="market-source">
        <strong>
          {score.area.displayName} {score.industry.displayName} 점포당 평균 기준 · 등급 {score.score!.grade}
        </strong>
        <p>
          월매출 기본값 {formatWon(score.financeDefault!.monthlyRevenue)}(잠정)은 {score.baseQuarterLabel}까지 최근
          4분기 매출 원값을 {interpretationPhrase(score.financeDefault!.interpretation)} 점포당 월평균입니다(원값 합{' '}
          {formatWon(score.financeDefault!.salesSum)} ÷ 점포 수 합{' '}
          {wonFormat.format(score.financeDefault!.storeCountSum)}
          {interpretationDivisor(score.financeDefault!.interpretation)}). 개인 예상매출이 아니니 고쳐 쓰세요.
        </p>
        {score.financeDefault!.unusual && <UnusualRevenueWarning score={score} />}
        <button type="button" onClick={onDisconnect}>
          상권 연결 해제
        </button>
      </div>
    );
  }
  if (stored) {
    return (
      <div className="market-source" role="note" data-testid="market-source">
        <strong>
          {stored.areaName} {stored.industryName} 점포당 평균 기준 · 등급 {stored.grade}
        </strong>
        <p>
          계획을 만들 때 저장한 값입니다. 기준분기 {quarterLabel(stored.baseQuarter)} · 점수 {stored.score}점 · 월매출
          기본값 {formatWon(stored.monthlyRevenueDefault)}(잠정)
        </p>
        {stored.monthlyRevenueUnusual && (
          <p className="inline-error" role="note">
            저장 당시 기본값이 같은 업종 상권의 상·하위 1% 범위를 벗어나 실제와 크게 다를 수 있습니다.
          </p>
        )}
        {stored.monthlyRevenueInterpretation !== CURRENT_MONTHLY_REVENUE_INTERPRETATION && (
          <p className="inline-error" role="note" data-testid="legacy-revenue-interpretation">
            이 기본값은 매출 원값을 {interpretationPhrase(stored.monthlyRevenueInterpretation)} 이전 해석으로 채워 지금
            해석({interpretationPhrase(CURRENT_MONTHLY_REVENUE_INTERPRETATION)} 값)보다 약 3배 클 수 있습니다. 월매출을
            확인해 주세요.
          </p>
        )}
      </div>
    );
  }
  return null;
}

// 계획에 저장된 자금 조건의 상태. 서버(plans/funding-matches.ts)와 같은 함수로 읽고 자치구를 보충한다.
type StoredFundingState = { kind: 'NONE' } | { kind: 'INVALID' } | { kind: 'OK'; summary: string; legacy: boolean };

function storedFundingState(plan: PlanDetail): StoredFundingState {
  const stored = readStoredFundingProfile(plan.fundingProfileJson);
  if (stored.kind !== 'OK') return { kind: stored.kind };
  const resolved = withBusinessDistrict(stored.profile, plan.businessProfileJson);
  return {
    kind: 'OK',
    summary: fundingProfileSummary(resolved.profile, resolved.districtSource),
    legacy: stored.legacy,
  };
}

// 계획에 저장할 자금 조건 입력. 아래 [조건 저장하고 공고 찾기]나 [초안 저장]이 재무 입력과 함께 저장한다.
function PlanFundingFields({
  form,
  onChange,
  businessDistrict,
}: {
  readonly form: FundingProfileForm;
  readonly onChange: (next: FundingProfileForm) => void;
  // 01 매장에서 고른 자치구. 자금 조건의 자치구를 비우면 서버가 이 값으로 맞춰 본다(저장한 뒤 찾으므로 화면 값과 같다).
  readonly businessDistrict: string | null;
}) {
  const districtHint =
    businessDistrict === null
      ? '비워 두면 01 매장에서 고른 자치구로 찾습니다.'
      : `비워 두면 01 매장에서 고른 ${districtName(businessDistrict)}로 찾습니다.`;
  return (
    <section className="form-section" aria-labelledby="plan-funding-fields">
      <div className="section-title">
        <div>
          <h2 id="plan-funding-fields">자금 조건</h2>
          <p className="picker-note">자금 공고를 찾을 때 씁니다. 비워 둬도 계산에는 영향이 없습니다.</p>
        </div>
      </div>
      <FundingProfileFields form={form} onChange={onChange} idPrefix="plan-funding" districtHint={districtHint} />
    </section>
  );
}

// 자금 조건으로 공고를 찾는다. 서버는 저장된 조건으로만 찾으므로, 버튼이 계획을 먼저 저장한다.
function PlanFundingPanel({
  stored,
  hasCondition,
  fundingGap,
  loading,
  matches,
  error,
  onQuery,
  appliedSummary,
}: {
  readonly stored: StoredFundingState | null;
  // 화면의 자금 조건에 값이 하나라도 있는지. 하나도 없으면 저장해도 조건이 비어 찾을 수 없다.
  readonly hasCondition: boolean;
  readonly fundingGap: ViewedFundingGap;
  readonly loading: boolean;
  readonly matches: PlanFundingMatchesResponse | null;
  readonly error: FundingLoadError | null;
  readonly onQuery: () => void;
  // 적용 기능을 없애기 전(ADR 0009 §5)에 저장된 대출 가정의 출처. 새로 만들지 않고 저장된 것만 보여 준다.
  readonly appliedSummary: string | null;
}) {
  return (
    <section className="picker" aria-labelledby="plan-funding">
      <h2 id="plan-funding">자금 공고 찾기</h2>
      <p className="picker-note">
        위 자금 조건을 저장하고 그 조건으로 찾습니다. 공고 조건은 AI가 공고문에서 읽은 것입니다.
      </p>

      {appliedSummary && <p className="funding-position">저장된 대출 가정 출처: {appliedSummary}</p>}
      {stored?.kind === 'OK' && stored.legacy && (
        <p className="picker-note" role="note">
          예전 자금 조건에서 사업 단계와 자치구만 옮겼습니다. 다음에 저장하면 지금 형식으로 바뀝니다.
        </p>
      )}
      {stored?.kind === 'INVALID' && (
        <p className="inline-error" role="status">
          저장된 자금 조건을 읽지 못했습니다. 다시 입력해 저장해 주세요.
        </p>
      )}

      <div className="button-row">
        <button type="button" disabled={!hasCondition || loading} onClick={onQuery}>
          {loading ? '찾는 중…' : '조건 저장하고 공고 찾기'}
        </button>
      </div>
      {!hasCondition && (
        <p className="picker-note" role="status">
          위 자금 조건을 하나 이상 넣으면 찾을 수 있습니다. 계산에는 필요 없습니다.
        </p>
      )}
      <div className="market-results" aria-live="polite" aria-busy={loading}>
        {loading && (
          <p className="loading-state" role="status">
            공고를 찾는 중…
          </p>
        )}
        {!loading && error && <FundingMatchesErrorPanel error={error} />}
        {!loading && !error && matches && (
          <FundingMatchesPanel
            result={matches}
            districtSource={matches.districtSource}
            planLabel={`${revisionLabel(matches.plan.revision)}의 조건으로 찾았습니다.`}
            fundingGap={fundingGap}
          />
        )}
      </div>
    </section>
  );
}

export default function TrendBenchApp() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending)
    return (
      <main>
        <p className="loading-state">로그인 상태를 확인하고 있습니다.</p>
      </main>
    );
  if (!session) return <AuthScreen />;
  // 계획 화면은 useSearchParams를 쓰므로 Suspense 경계 안에 둔다.
  return (
    <Suspense>
      <AuthenticatedWorkspace key={session.user.id} email={session.user.email} />
    </Suspense>
  );
}
