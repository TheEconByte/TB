'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import FinancePlanner, { defaultInputWith } from '@/features/finance/FinancePlanner';
import { quarterLabel } from '@/features/market/quarter';
import type { MarketScoreResponse } from '@/features/market/score/api';
import { clearHandoff, handoffFromSearch, scoreApiUrl, type MarketScoreHandoff } from '@/features/market/score/handoff';
import { UnusualRevenueWarning } from '@/features/market/score/ScorePanel';
import { parsePlanMarketScore } from '@/features/plans/market-score';
import type { FinanceInput, FinanceResult } from '@/features/finance/types';
import { districtName } from '@/features/funding/districts';
import FundingProfileFields from '@/features/funding/FundingProfileFields';
import {
  FundingMatchesErrorPanel,
  FundingMatchesPanel,
  describeFundingError,
  type FundingLoadError,
} from '@/features/funding/FundingMatchesPanel';
import {
  businessProfileDistrict,
  readStoredFundingProfile,
  withBusinessDistrict,
} from '@/features/funding/match-profile';
import { fundingProfileSummary, type ViewedFundingGap } from '@/features/funding/match-text';
import type { FundingMatchProfile } from '@/features/funding/matching';
import {
  EMPTY_FUNDING_FORM,
  businessDistrictUnsaved,
  fundingFormFromProfile,
  fundingFormPayload,
  type FundingProfileForm,
} from '@/features/funding/profile-form';
import type { PlanFundingMatchesResponse } from '@/features/plans/funding-matches';
import {
  describeLoanAssumption,
  planLoanAssumptionSchema,
  type PlanLoanAssumption,
} from '@/features/plans/loan-assumption';
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

type PlanSummary = { id: string; title: string; revision: number; updatedAt: string; _count: { results: number } };
type ResultSummary = { id: string; inputRevision: number; calculationVersion: string; calculatedAt: string };
type PlanDetail = {
  id: string;
  title: string;
  revision: number;
  inputJson: FinanceInput;
  fundingProfileJson: unknown;
  businessProfileJson: unknown;
  loanAssumptionJson?: unknown;
  marketScoreJson?: unknown;
  results: ResultSummary[];
};
// 상권 탐색에서 넘어와 아직 저장하지 않은 새 계획의 출처.
type MarketSource = { handoff: MarketScoreHandoff; score: MarketScoreResponse };

const wonFormat = new Intl.NumberFormat('ko-KR');
const formatWon = (value: string) => `${wonFormat.format(BigInt(value))}원`;
type StoredResult = { id: string; inputRevision: number; resultJson: FinanceResult; loanAssumptionJson?: unknown };

// 자금 조건은 재무 입력과 별도로 저장한다(ADR 0009 §4). 입력란 상태와 본문 변환은 /funding과 같은 profile-form.ts를 쓴다.

// 저장된 자금 조건을 입력란으로 되돌린다. 예전 모양은 사업 단계·자치구만 옮긴다(match-profile.ts). 어느 모양에도 맞지
// 않으면 다른 값으로 해석하지 않고 빈 입력란으로 두며, 조회는 서버가 400으로 거부한다.
function fundingFormFromStored(value: unknown): FundingProfileForm {
  const stored = readStoredFundingProfile(value);
  return stored.kind === 'OK' ? fundingFormFromProfile(stored.profile) : EMPTY_FUNDING_FORM;
}

const isEmptyFundingForm = (form: FundingProfileForm) => fundingFormPayload(form).kind === 'EMPTY';

// 저장 전 변경 여부를 본문 기준으로 비교한다. 형식이 틀린 입력도 저장된 조건과 다른 것으로 본다.
const fundingFormKey = (form: FundingProfileForm) => JSON.stringify(fundingFormPayload(form));

// 저장된 대출 가정의 출처를 화면에서 쓰는 값으로 되돌린다. 스키마와 맞지 않으면 임의로
// 해석하지 않고 출처 없음으로 둔다.
function parseLoanAssumption(value: unknown): PlanLoanAssumption | null {
  if (value === null || value === undefined) return null;
  const parsed = planLoanAssumptionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? '요청을 처리하지 못했습니다.') as Error & { code?: string };
    error.code = body?.error?.code;
    throw error;
  }
  return body as T;
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
      <header>
        <span className="brand">
          TrendBench<span>창업 준비의 기준</span>
        </span>
        <div className="header-actions">
          <a className="link-button" href="/markets">
            상권 탐색
          </a>
          <a className="link-button" href="/funding">
            자금 후보
          </a>
          <span className="badge">인증 필요</span>
        </div>
      </header>
      <section className="auth-shell">
        <div>
          <p className="eyebrow">개인 계획 보호</p>
          <h1>
            계획을 저장하려면
            <br />
            로그인해 주세요.
          </h1>
          <p>이메일은 로그인 식별에만 사용합니다. 실제 이메일 발송과 비밀번호 복구는 아직 제공하지 않습니다.</p>
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
          `${score.area.displayName} ${score.industry.displayName} 상권 점수에서 시작합니다. 자치구·월매출을 미리 채웠습니다.`,
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
    setMessage('상권 연결을 해제했습니다. 미리 채운 값은 직접 고칠 수 있습니다.');
  }

  const refreshPlans = useCallback(async () => {
    const data = await api<{ plans: PlanSummary[] }>('/api/plans');
    setPlans(data.plans);
  }, []);
  const openPlan = useCallback(async (id: string) => {
    setBusy(true);
    setMessage('');
    try {
      const data = await api<{ plan: PlanDetail }>(`/api/plans/${id}`);
      setPlan(data.plan);
      setStoredResult(null);
      // 계획을 열면 저장된 자금 조건을 그대로 보여주고 이전 판정 결과는 지운다.
      setFundingForm(fundingFormFromStored(data.plan.fundingProfileJson));
      setMatches(null);
      setMatchesError(null);
      setBusinessForm(businessProfileFormFromStored(data.plan.businessProfileJson));
      if (data.plan.results[0]) {
        const resultData = await api<{ result: StoredResult }>(`/api/plans/${id}/results/${data.plan.results[0].id}`);
        setStoredResult(resultData.result);
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

  async function saveDraft(title: string, input: FinanceInput) {
    // 자금 조건 형식(나이·개업 연월)은 서버에 보내기 전에 막는다. 형식이 틀리면 계획 저장 요청 전체가
    // 400으로 거부되어 재무 입력까지 함께 저장되지 않기 때문이다.
    const funding = fundingFormPayload(fundingForm);
    if (funding.kind === 'INVALID') {
      const fundingIssue = `자금 조건을 확인해 주세요: ${funding.issue}`;
      setMessage(fundingIssue);
      requestAnimationFrame(() => document.querySelector('.status-message')?.scrollIntoView({ block: 'start' }));
      throw new Error(fundingIssue);
    }
    // 사업 조건을 일부만 입력한 채 저장하면 null이 가서 저장된 조건까지 지워진다. 저장 전에 막는다.
    const profileState = businessProfileSaveState(businessForm);
    if (profileState.kind === 'INCOMPLETE') {
      const profileIssue = `사업 조건에 빠진 항목이 있어 저장하지 않았습니다: ${profileState.missing.join(', ')}. 사업 조건을 마저 입력하거나, 입력 확인 단계에서 모두 비운 뒤 다시 저장해 주세요.`;
      setMessage(profileIssue);
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
          ? '다른 화면에서 먼저 수정되었습니다. 계획을 다시 열어 최신 내용을 확인해 주세요.'
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
    setMessage('서버에서 저장된 입력을 계산하고 있습니다.');
    try {
      const data = await api<{ result: StoredResult; reused: boolean }>(`/api/plans/${saved.id}/calculations`, {
        method: 'POST',
      });
      setStoredResult(data.result);
      await openPlan(saved.id);
      setStoredResult(data.result);
      setMessage(data.reused ? '동일 revision의 기존 계산 결과를 불러왔습니다.' : '새 계산 결과를 저장했습니다.');
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
      setStoredResult(null);
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
  // 저장된 계획 조건으로만 판정한다. 요청 본문에 조건이나 기준일을 보내지 않는다.
  async function queryPlanFundingMatches() {
    if (!plan) return;
    setMatchesLoading(true);
    setMatchesError(null);
    try {
      const data = await api<PlanFundingMatchesResponse>(`/api/plans/${plan.id}/funding-matches`, { method: 'POST' });
      setMatches(data);
    } catch (error) {
      setMatches(null);
      setMatchesError(describeFundingError(error));
    } finally {
      setMatchesLoading(false);
    }
  }

  const storedFunding = plan ? storedFundingState(plan) : null;
  const fundingDirty =
    plan !== null && fundingFormKey(fundingForm) !== fundingFormKey(fundingFormFromStored(plan.fundingProfileJson));
  const savedBusinessDistrict = plan ? businessProfileDistrict(plan.businessProfileJson) : null;
  // 사업 조건의 자치구를 바꾸고 저장하지 않았으면 서버가 화면과 다른 자치구로 맞춰 보므로 조회를 막는다.
  const businessDistrictDirty =
    plan !== null && businessDistrictUnsaved(fundingForm, businessForm.districtCode, savedBusinessDistrict);
  // 보고 있는 저장 결과의 부족자금. 다시 계산하지 않는다.
  const viewedFundingGap: ViewedFundingGap = storedResult
    ? { revision: storedResult.inputRevision, value: storedResult.resultJson.plannedFundingGap }
    : null;
  const storedAssumption = plan ? parseLoanAssumption(plan.loanAssumptionJson) : null;
  const pendingMarket = plan === null ? marketSource : null;
  const storedMarketScore = plan ? parsePlanMarketScore(plan.marketScoreJson) : null;
  const resultAssumption = parseLoanAssumption(storedResult?.loanAssumptionJson);

  return (
    <main>
      <header>
        <a href="#top" className="brand">
          TrendBench<span>창업 준비의 기준</span>
        </a>
        <div className="account-actions">
          <a className="link-button" href="/markets">
            상권 탐색
          </a>
          <a className="link-button" href="/funding">
            자금 후보
          </a>
          <span>{email}</span>
          <button className="link-button" onClick={() => void authClient.signOut()}>
            로그아웃
          </button>
        </div>
      </header>
      <div className="workspace" id="top">
        <aside className="plan-sidebar">
          <div className="sidebar-heading">
            <h2>내 계획</h2>
            <button
              onClick={() => {
                setPlan(null);
                setStoredResult(null);
                // 상권에서 넘어온 연결이 남아 있으면 새 계획에 다시 미리 채운다.
                setFundingForm(
                  marketSource
                    ? { ...EMPTY_FUNDING_FORM, districtCode: marketSource.score.area.districtCode }
                    : EMPTY_FUNDING_FORM,
                );
                setBusinessForm(EMPTY_BUSINESS_PROFILE_FORM);
                setMatches(null);
                setMatchesError(null);
                setMessage('새 계획을 작성합니다.');
              }}
            >
              새 계획
            </button>
          </div>
          {plans.length === 0 ? (
            <p className="empty-state">
              저장된 계획이 없습니다.
              <br />첫 초안을 만들어 보세요.
            </p>
          ) : (
            <ul>
              {plans.map((item) => (
                <li key={item.id}>
                  <button className={plan?.id === item.id ? 'active' : ''} onClick={() => void openPlan(item.id)}>
                    <strong>{item.title}</strong>
                    <span>
                      revision {item.revision} · 결과 {item._count.results}개
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
          {plan && plan.results.length > 0 && (
            <div className="result-history">
              <strong>저장 결과</strong>
              {plan.results.map((result) => (
                <button
                  key={result.id}
                  className={storedResult?.id === result.id ? 'active' : ''}
                  onClick={() => void openResult(result.id)}
                >
                  revision {result.inputRevision} · {new Date(result.calculatedAt).toLocaleString('ko-KR')}
                </button>
              ))}
            </div>
          )}
          {resultAssumption && (
            <p className="funding-position">저장 결과에 반영된 대출 가정: {describeLoanAssumption(resultAssumption)}</p>
          )}
          <BusinessProfileWizard
            form={businessForm}
            onChange={setBusinessForm}
            onFinish={() =>
              document.getElementById('rent-benchmark-title')?.closest('section')?.scrollIntoView({ block: 'start' })
            }
          />
          <RentBenchmarkPanel
            profile={businessForm}
            savedMonthlyRent={plan?.inputJson.monthlyFixedCosts.rent ?? null}
          />
          <FranchisePanel
            industryCode={businessForm.marketIndustryCode}
            savedMonthlyRevenue={plan?.inputJson.monthlyRevenue ?? null}
          />
          {plan === null && marketLoading ? (
            <p className="loading-state" role="status">
              상권 점수를 불러오고 있습니다.
            </p>
          ) : (
            <FinancePlanner
              // 상권 연결 여부는 key에 넣지 않는다. 연결을 해제할 때 폼을 다시 만들면 저장하지 않은 입력이 사라진다.
              key={plan?.id ?? 'new'}
              initialTitle={
                plan?.title ??
                (pendingMarket
                  ? `${pendingMarket.score.area.displayName} ${pendingMarket.score.industry.displayName} 계획`
                  : undefined)
              }
              initialInput={
                plan?.inputJson ??
                (pendingMarket?.score.financeDefault
                  ? defaultInputWith({ monthlyRevenue: pendingMarket.score.financeDefault.monthlyRevenue })
                  : undefined)
              }
              initialResult={storedResult?.resultJson}
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
              onSave={saveDraft}
              onCalculate={calculate}
            />
          )}
          <PlanFundingPanel
            plan={plan}
            form={fundingForm}
            onChange={setFundingForm}
            stored={storedFunding}
            savedBusinessDistrict={savedBusinessDistrict}
            fundingGap={viewedFundingGap}
            dirty={fundingDirty}
            businessDistrictDirty={businessDistrictDirty}
            loading={matchesLoading}
            matches={matches}
            error={matchesError}
            onQuery={() => void queryPlanFundingMatches()}
            appliedSummary={storedAssumption ? describeLoanAssumption(storedAssumption) : null}
          />
        </div>
      </div>
      <footer>TrendBench · 내부 MVP · 공개 출시 준비 완료 상태가 아닙니다.</footer>
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
          월매출 기본값 {formatWon(score.financeDefault!.monthlyRevenue)}은 {score.baseQuarterLabel}까지 최근 4분기
          서울시 매출 원값을 점포당 월평균으로 본 잠정값입니다(원값 합 {formatWon(score.financeDefault!.salesSum)} ÷
          점포 수 합 {wonFormat.format(score.financeDefault!.storeCountSum)}). 개인 예상매출이 아니며 고쳐서 쓸 수
          있습니다. 저장하면 상권 코드·등급·모델 버전을 함께 보존합니다.
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
          계획을 만들 때 저장한 값입니다. 다시 계산하지 않습니다. 기준분기 {quarterLabel(stored.baseQuarter)} · 점수{' '}
          {stored.score}점 · 모델 {stored.modelVersion} · 월매출 기본값 {formatWon(stored.monthlyRevenueDefault)}(잠정)
        </p>
        {stored.monthlyRevenueUnusual && (
          <p className="inline-error" role="note">
            저장 당시 기본값이 같은 업종 상권의 하위·상위 1% 범위를 벗어났습니다. 개인 점포 매출과 크게 다를 수
            있습니다.
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

function PlanFundingPanel({
  plan,
  form,
  onChange,
  stored,
  savedBusinessDistrict,
  fundingGap,
  dirty,
  businessDistrictDirty,
  loading,
  matches,
  error,
  onQuery,
  appliedSummary,
}: {
  readonly plan: { id: string; revision: number } | null;
  readonly form: FundingProfileForm;
  readonly onChange: (next: FundingProfileForm) => void;
  readonly stored: StoredFundingState | null;
  // 자금 조건의 자치구가 비었을 때 서버가 대신 쓰는, 계획에 저장된 사업 조건의 자치구.
  readonly savedBusinessDistrict: string | null;
  readonly fundingGap: ViewedFundingGap;
  readonly dirty: boolean;
  // 자금 조건의 자치구가 비어 있고 사업 조건의 자치구를 바꾼 뒤 저장하지 않았다.
  readonly businessDistrictDirty: boolean;
  readonly loading: boolean;
  readonly matches: PlanFundingMatchesResponse | null;
  readonly error: FundingLoadError | null;
  readonly onQuery: () => void;
  // 적용 기능을 없애기 전(ADR 0009 §5)에 저장된 대출 가정의 출처. 새로 만들지 않고 저장된 것만 보여 준다.
  readonly appliedSummary: string | null;
}) {
  // 조건 미입력·저장 전 변경·정상 조회를 서로 다른 상태로 보여 준다. 조회는 항상
  // 서버에 저장된 조건으로만 하므로 저장하지 않은 변경이 있으면 막는다.
  const hasStoredProfile = stored !== null && stored.kind !== 'NONE';
  const canQuery = plan !== null && hasStoredProfile && !dirty && !businessDistrictDirty && !loading;
  // 자치구만 입력했다가 비우면 조건이 하나도 없어 저장된 조건이 비워진다(조회 불가). 그래서 다른 조건과 함께일 때로 쓴다.
  const districtHint =
    savedBusinessDistrict === null
      ? '자치구를 비워 두고 다른 조건을 저장하면, 계획에 저장된 사업 조건의 자치구로 맞춰 봅니다. 그것도 없으면 지역은 확인 필요로 남습니다.'
      : `자치구를 비워 두고 다른 조건을 저장하면, 계획에 저장된 사업 조건의 자치구(${districtName(savedBusinessDistrict)})로 맞춰 봅니다.`;
  return (
    <section className="picker" aria-labelledby="plan-funding">
      <h2 id="plan-funding">계획 기준 자금 공고 맞춰 보기</h2>
      <p className="picker-note">
        이 계획에 저장한 자금 조건으로, AI가 공고문에서 읽어 둔 조건과 항목마다 맞춰 봅니다. 재무 계산 입력과 분리해
        저장하며, 조건을 바꾼 뒤에는 초안을 저장해야 조회에 반영됩니다.
      </p>
      <FundingProfileFields form={form} onChange={onChange} idPrefix="plan-funding" districtHint={districtHint} />

      {plan === null && (
        <p className="empty-state">새 계획은 먼저 초안을 저장해야 저장된 조건으로 공고를 맞춰 볼 수 있습니다.</p>
      )}

      {plan !== null && appliedSummary && <p className="funding-position">저장된 대출 가정 출처: {appliedSummary}</p>}

      {plan !== null && !hasStoredProfile && (
        <div className="empty-panel" role="status">
          <h2>저장된 자금 조건이 없습니다.</h2>
          <p>
            위에서 조건을 하나 이상 입력하고 초안을 저장하면 저장된 조건으로 공고를 맞춰 볼 수 있습니다. 조건 없이
            조회하면 0건이 아니라 400으로 거부됩니다.
          </p>
        </div>
      )}

      {plan !== null && hasStoredProfile && (
        <>
          {stored?.kind === 'OK' && <p className="funding-position">저장된 조건: {stored.summary}</p>}
          {stored?.kind === 'OK' && stored.legacy && (
            <p className="picker-note" role="note">
              예전 자금 조건에서 사업 단계와 자치구만 옮겼습니다. 업종·용도는 더 쓰지 않으며, 다음에 초안을 저장하면
              지금 모양으로 저장합니다(옮길 값이 없으면 저장된 조건을 비웁니다).
            </p>
          )}
          {stored?.kind === 'INVALID' && (
            <p className="inline-error" role="status">
              저장된 자금 조건을 읽지 못해 빈 입력란으로 보여 줍니다. 조건을 다시 입력해 저장해 주세요.
            </p>
          )}
          {dirty && (
            <p className="inline-error" role="status">
              아직 저장하지 않은 조건 변경이 있습니다. 초안을 저장한 뒤 조회해 주세요.
            </p>
          )}
          {!dirty && businessDistrictDirty && (
            <p className="inline-error" role="status">
              사업 조건의 자치구를 바꾼 뒤 저장하지 않았습니다. 자금 조건의 자치구가 비어 있어 그 값으로 맞춰 보므로,
              초안을 저장한 뒤 조회해 주세요.
            </p>
          )}
          <div className="button-row">
            <button type="button" disabled={!canQuery} onClick={onQuery}>
              {loading ? '맞춰 보는 중…' : '계획 조건으로 공고 맞춰 보기'}
            </button>
          </div>
          <div className="market-results" aria-live="polite" aria-busy={loading}>
            {loading && (
              <p className="loading-state" role="status">
                저장된 계획 조건으로 공고를 맞춰 보는 중…
              </p>
            )}
            {!loading && error && <FundingMatchesErrorPanel error={error} />}
            {!loading && !error && matches && (
              <FundingMatchesPanel
                result={matches}
                districtSource={matches.districtSource}
                planLabel={`계획 revision ${matches.plan.revision}에 저장된 조건으로 맞춰 봤습니다.`}
                fundingGap={fundingGap}
              />
            )}
            {!loading && !error && !matches && (
              <p className="empty-state">
                계획 조건으로 공고 맞춰 보기를 누르면 갈래마다 남은 공고와 공고가 밝힌 조건을 보여 줍니다.
              </p>
            )}
          </div>
        </>
      )}
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
