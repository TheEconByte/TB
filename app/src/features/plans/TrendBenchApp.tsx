'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import FinancePlanner from '@/features/finance/FinancePlanner';
import type { FinanceInput, FinanceResult } from '@/features/finance/types';
import { SEOUL_DISTRICTS } from '@/features/funding/districts';
import {
  industryCodeIssue,
  purposeLabel,
  stageLabel,
  type FundingCandidateEvaluation,
  type FundingProfile,
} from '@/features/funding/eligibility';
import {
  FundingCandidatesErrorPanel,
  FundingCandidatesPanel,
  describeFundingError,
  fundingProfileSummary,
  type FundingLoadError,
} from '@/features/funding/FundingCandidatesPanel';
import { PURPOSES, type BusinessStage, type Purpose } from '@/features/funding/types';
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
  results: ResultSummary[];
};
type StoredResult = { id: string; inputRevision: number; resultJson: FinanceResult; loanAssumptionJson?: unknown };

// 자금 후보 조건은 재무 입력과 별도로 저장한다. 화면에서는 빈 선택값을 문자열로
// 다루고, 저장할 때만 F4-2와 같은 스키마 모양(UNKNOWN·null)으로 바꾼다.
type FundingProfileForm = {
  businessStage: BusinessStage | 'UNKNOWN';
  districtCode: string;
  industryCode: string;
  purpose: Purpose | 'UNKNOWN';
};
const EMPTY_FUNDING_FORM: FundingProfileForm = {
  businessStage: 'UNKNOWN',
  districtCode: '',
  industryCode: '',
  purpose: 'UNKNOWN',
};
const PURPOSE_SET = new Set<string>(PURPOSES);

function fundingPayload(form: FundingProfileForm): FundingProfile {
  const industry = form.industryCode.trim().toUpperCase();
  return {
    businessStage: form.businessStage,
    districtCode: form.districtCode === '' ? null : form.districtCode,
    industryCode: industry === '' ? null : industry,
    purpose: form.purpose,
  };
}

// 조건을 하나도 입력하지 않으면 UNKNOWN 프로필을 저장하지 않고 null을 보낸다. 조건 없음과
// "모두 미확인"을 구분해 사용자가 저장된 조건을 비울 수 있게 한다.
function isEmptyFundingForm(form: FundingProfileForm): boolean {
  return (
    form.businessStage === 'UNKNOWN' &&
    form.districtCode === '' &&
    form.industryCode.trim() === '' &&
    form.purpose === 'UNKNOWN'
  );
}

function fundingPayloadOrNull(form: FundingProfileForm): FundingProfile | null {
  return isEmptyFundingForm(form) ? null : fundingPayload(form);
}

// 저장된 프로필을 화면 입력값으로 되돌린다. 스키마를 통과하지 못한 값은 임의로
// 해석하지 않고 미입력으로 두며, 조회는 서버가 400으로 거부한다.
function fundingFormFromStored(value: unknown): FundingProfileForm {
  if (value === null || value === undefined || typeof value !== 'object') return EMPTY_FUNDING_FORM;
  const stored = value as Partial<FundingProfile>;
  return {
    businessStage:
      stored.businessStage === 'PRE_REGISTRATION' || stored.businessStage === 'POST_REGISTRATION'
        ? stored.businessStage
        : 'UNKNOWN',
    districtCode: typeof stored.districtCode === 'string' ? stored.districtCode : '',
    industryCode: typeof stored.industryCode === 'string' ? stored.industryCode : '',
    purpose:
      typeof stored.purpose === 'string' && PURPOSE_SET.has(stored.purpose) ? (stored.purpose as Purpose) : 'UNKNOWN',
  };
}

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
  // 재무 입력에 저장하지 않은 변경이 있는지와 지금 어느 상품 조건을 적용 중인지.
  const [financeDirty, setFinanceDirty] = useState(false);
  const [applyingKey, setApplyingKey] = useState<string | null>(null);
  // 상품 확정 조건을 적용하면 저장된 입력이 바뀌므로 폼을 그 입력으로 다시 채우는 신호.
  const [formSyncToken, setFormSyncToken] = useState(0);

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
    // 업종 코드 형식은 서버에 보내기 전에 막는다. 형식이 틀리면 계획 저장 요청 전체가
    // 400으로 거부되어 재무 입력까지 함께 저장되지 않기 때문이다.
    const industryIssue = industryCodeIssue(fundingForm.industryCode);
    if (industryIssue) {
      setMessage(industryIssue);
      throw new Error(industryIssue);
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
      // 건드리지 않고 조건만 따로 보존한다.
      const fundingProfile = fundingPayloadOrNull(fundingForm);
      const businessProfile = profileState.kind === 'COMPLETE' ? profileState.payload : null;
      const data = plan
        ? await api<{ plan: PlanDetail }>(`/api/plans/${plan.id}`, {
            method: 'PUT',
            body: JSON.stringify({ title, input, fundingProfile, businessProfile, revision: plan.revision }),
          })
        : await api<{ plan: PlanDetail }>('/api/plans', {
            method: 'POST',
            body: JSON.stringify({ title, input, fundingProfile, businessProfile }),
          });
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

  // 상품 확정 조건을 계획의 신규 대출 가정으로 적용한다. 사용자가 명시적으로 누를 때만
  // 실행하며, 적용 대상 상품과 확정 조건은 서버가 활성 카탈로그에서 다시 확인한다.
  async function applyLoanAssumption(evaluation: FundingCandidateEvaluation) {
    if (!plan) return;
    const key = `${evaluation.productKey}@${evaluation.version}`;
    setApplyingKey(key);
    setMessage('');
    try {
      const data = await api<{ plan: Omit<PlanDetail, 'results'>; loanAssumption: PlanLoanAssumption }>(
        `/api/plans/${plan.id}/loan-assumption`,
        {
          method: 'POST',
          body: JSON.stringify({
            productKey: evaluation.productKey,
            version: evaluation.version,
            revision: plan.revision,
          }),
        },
      );
      setPlan({ ...data.plan, results: plan.results });
      setFormSyncToken((token) => token + 1);
      setMessage(
        `상품 ${key} 확정 조건을 대출 가정으로 적용하고 초안 revision ${data.plan.revision}으로 저장했습니다. 승인 확정이 아닙니다.`,
      );
      await refreshPlans();
    } catch (error) {
      const typed = error as Error & { code?: string };
      setMessage(
        typed.code === 'REVISION_CONFLICT'
          ? '다른 화면에서 먼저 수정되었습니다. 계획을 다시 열어 최신 내용을 확인해 주세요.'
          : typed.message,
      );
    } finally {
      setApplyingKey(null);
    }
  }

  const storedFundingForm = plan ? fundingFormFromStored(plan.fundingProfileJson) : null;
  const storedHasProfile = plan !== null && plan.fundingProfileJson !== null && plan.fundingProfileJson !== undefined;
  const fundingDirty =
    plan !== null &&
    JSON.stringify(fundingPayloadOrNull(fundingForm)) !==
      JSON.stringify(fundingPayloadOrNull(storedFundingForm ?? EMPTY_FUNDING_FORM));
  const storedFundingSummary =
    storedHasProfile && storedFundingForm ? fundingProfileSummary(fundingPayload(storedFundingForm)) : null;
  const storedAssumption = plan ? parseLoanAssumption(plan.loanAssumptionJson) : null;
  const resultAssumption = parseLoanAssumption(storedResult?.loanAssumptionJson);
  const canApplyLoanAssumption = plan !== null && !financeDirty && !fundingDirty && !busy;
  const applyDisabledReason =
    plan === null
      ? '새 계획은 먼저 초안을 저장해야 상품 조건을 적용할 수 있습니다.'
      : financeDirty || fundingDirty
        ? '저장하지 않은 변경이 있습니다. 초안을 저장한 뒤 적용해 주세요.'
        : busy
          ? '다른 작업을 처리하고 있습니다.'
          : '';

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
                setFundingForm(EMPTY_FUNDING_FORM);
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
          <FinancePlanner
            key={plan?.id ?? 'new'}
            initialTitle={plan?.title}
            initialInput={plan?.inputJson}
            initialResult={storedResult?.resultJson}
            revision={plan?.revision ?? null}
            resultRevision={storedResult?.inputRevision ?? null}
            busy={busy}
            syncToken={formSyncToken}
            onDirtyChange={setFinanceDirty}
            onSave={saveDraft}
            onCalculate={calculate}
          />
          <PlanFundingPanel
            plan={plan}
            principalKrw={plan?.inputJson.newLoan.principal ?? null}
            form={fundingForm}
            onChange={setFundingForm}
            hasStoredProfile={storedHasProfile}
            storedSummary={storedFundingSummary}
            dirty={fundingDirty}
            loading={matchesLoading}
            matches={matches}
            error={matchesError}
            onQuery={() => void queryPlanFundingMatches()}
            appliedSummary={storedAssumption ? describeLoanAssumption(storedAssumption) : null}
            appliedKey={storedAssumption ? `${storedAssumption.productKey}@${storedAssumption.version}` : null}
            applyingKey={applyingKey}
            canApply={canApplyLoanAssumption}
            applyDisabledReason={applyDisabledReason}
            onApply={(evaluation: FundingCandidateEvaluation) => void applyLoanAssumption(evaluation)}
          />
        </div>
      </div>
      <footer>TrendBench · 내부 MVP · 공개 출시 준비 완료 상태가 아닙니다.</footer>
    </main>
  );
}

function PlanFundingPanel({
  plan,
  principalKrw,
  form,
  onChange,
  hasStoredProfile,
  storedSummary,
  dirty,
  loading,
  matches,
  error,
  onQuery,
  appliedSummary,
  appliedKey,
  applyingKey,
  canApply,
  applyDisabledReason,
  onApply,
}: {
  readonly plan: { id: string; revision: number } | null;
  readonly principalKrw: string | null;
  readonly form: FundingProfileForm;
  readonly onChange: (next: FundingProfileForm) => void;
  readonly hasStoredProfile: boolean;
  readonly storedSummary: string | null;
  readonly dirty: boolean;
  readonly loading: boolean;
  readonly matches: PlanFundingMatchesResponse | null;
  readonly error: FundingLoadError | null;
  readonly onQuery: () => void;
  // 저장된 대출 가정의 출처와 적용 동작. 계획이 저장되지 않았거나 편집 중이면 막는다.
  readonly appliedSummary: string | null;
  readonly appliedKey: string | null;
  readonly applyingKey: string | null;
  readonly canApply: boolean;
  readonly applyDisabledReason: string;
  readonly onApply: (evaluation: FundingCandidateEvaluation) => void;
}) {
  // 프로필 미입력·저장 전 변경·정상 조회를 서로 다른 상태로 보여준다. 조회는 항상
  // 서버에 저장된 조건으로만 하므로 저장하지 않은 변경이 있으면 막는다.
  const canQuery = plan !== null && hasStoredProfile && !dirty && !loading;
  return (
    <section className="picker" aria-labelledby="plan-funding">
      <h2 id="plan-funding">계획 기준 자금 후보</h2>
      <p className="picker-note">
        이 계획에 저장한 사업단계·자치구·업종·용도로 활성 자금 카탈로그를 판정합니다. 재무 계산 입력과 분리해 저장하며,
        조건을 바꾼 뒤에는 초안을 저장해야 조회에 반영됩니다.
      </p>
      <div className="select-row">
        <label className="field">
          <span>1. 사업 단계</span>
          <select
            value={form.businessStage}
            onChange={(event) => onChange({ ...form, businessStage: event.target.value as BusinessStage | 'UNKNOWN' })}
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
          <select
            value={form.districtCode}
            onChange={(event) => onChange({ ...form, districtCode: event.target.value })}
          >
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
              value={form.industryCode}
              placeholder="예: CS100010"
              onChange={(event) => onChange({ ...form, industryCode: event.target.value })}
            />
          </span>
          <small>업종 코드는 CS100001 형식이어야 합니다. 비워두면 업종 조건은 미확인으로 남습니다.</small>
        </label>
        <label className="field">
          <span>4. 자금 용도</span>
          <select
            value={form.purpose}
            onChange={(event) => onChange({ ...form, purpose: event.target.value as Purpose | 'UNKNOWN' })}
          >
            <option value="UNKNOWN">아직 정하지 않음(미확인)</option>
            {PURPOSES.map((item) => (
              <option key={item} value={item}>
                {purposeLabel(item)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {plan === null && (
        <p className="empty-state">새 계획은 먼저 초안을 저장해야 저장된 조건으로 후보를 조회할 수 있습니다.</p>
      )}

      {plan !== null && appliedSummary && <p className="funding-position">저장된 대출 가정 출처: {appliedSummary}</p>}

      {plan !== null && !hasStoredProfile && (
        <div className="empty-panel" role="status">
          <h2>저장된 자금 조건이 없습니다.</h2>
          <p>
            위에서 조건을 입력하고 초안을 저장하면 저장된 조건으로 후보를 조회할 수 있습니다. 조건 없이 조회하면 후보
            0건이 아니라 400으로 거부됩니다.
          </p>
        </div>
      )}

      {plan !== null && hasStoredProfile && (
        <>
          <p className="funding-position">저장된 조건: {storedSummary}</p>
          {dirty && (
            <p className="inline-error" role="status">
              아직 저장하지 않은 조건 변경이 있습니다. 초안을 저장한 뒤 조회해 주세요.
            </p>
          )}
          <div className="button-row">
            <button type="button" disabled={!canQuery} onClick={onQuery}>
              {loading ? '조회 중…' : '계획 조건으로 후보 조회'}
            </button>
          </div>
          <div className="market-results" aria-live="polite" aria-busy={loading}>
            {loading && (
              <p className="loading-state" role="status">
                저장된 계획 조건으로 후보를 판정하는 중…
              </p>
            )}
            {!loading && error && <FundingCandidatesErrorPanel error={error} />}
            {!loading && !error && matches && (
              <FundingCandidatesPanel
                result={matches}
                profileSummary={fundingProfileSummary(matches.profile)}
                planLabel={`계획 revision ${matches.plan.revision}에 저장된 조건으로 판정했습니다.`}
                apply={{
                  disabled: !canApply,
                  disabledReason: applyDisabledReason,
                  applyingKey,
                  appliedKey,
                  onApply,
                  principalKrw,
                }}
              />
            )}
            {!loading && !error && !matches && (
              <p className="empty-state">계획 조건으로 후보 조회를 누르면 상태별 후보와 이유를 표시합니다.</p>
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
  return <AuthenticatedWorkspace key={session.user.id} email={session.user.email} />;
}
