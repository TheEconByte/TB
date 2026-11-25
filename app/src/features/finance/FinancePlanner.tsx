'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fromInput, sameAsCalculatedInput, toInput, type FinanceForm } from './form';
import {
  cashRunwayText,
  fieldLabel,
  formatWonText,
  fundingPositionText,
  revenueVerdict,
  showValue,
  type Verdict,
} from './result-text';
import { financeInputSchema } from './schema';
import { revisionLabel } from '@/lib/revision-text';
import type { FinanceInput, FinanceResult, ScenarioResult, ValueResult } from './types';

// 계획 단계. 창업자가 정하는 순서다: 어디서 무엇을 할지 → 개업에 드는 돈 → 한 달 수입과 지출 → 돈 마련 → 결과 →
// 모자란 돈을 채울 자금 공고. 한 화면에 한 단계만 보이고, 단계를 바꿔도 입력은 지우지 않는다.
export const PLAN_STEPS = [
  { key: 'business', title: '매장' },
  { key: 'opening', title: '개업 비용' },
  { key: 'operating', title: '월 운영' },
  { key: 'financing', title: '자금 마련' },
  { key: 'result', title: '결과' },
  { key: 'funding', title: '자금 공고' },
] as const;
export type PlanStep = (typeof PLAN_STEPS)[number]['key'];
type InputStep = 'opening' | 'operating' | 'financing';
// 결과 문장·입력 오류가 보낼 수 있는 단계. 현금잔액 계산기간은 결과 단계에서 바꾼다.
type FixStep = InputStep | 'result';

const stepIndex = (step: PlanStep) => PLAN_STEPS.findIndex((item) => item.key === step);
const stepTitle = (step: PlanStep) => PLAN_STEPS[stepIndex(step)].title;
const stepNumber = (step: PlanStep) => String(stepIndex(step) + 1).padStart(2, '0');

// 결과의 빠진 입력(missingFields)과 입력 검증 오류가 어느 단계에 있는지.
function stepOfField(field: string): FixStep {
  if (field.startsWith('openingExpenses.') || field === 'targetReserve') return 'opening';
  if (field === 'cashBalanceMonths') return 'result';
  if (field === 'equity' || field.startsWith('newLoan.')) return 'financing';
  return 'operating';
}

const moneyFields = new Set([
  'deposit',
  'facilities',
  'initialInventory',
  'otherPreparation',
  'targetReserve',
  'equity',
  'monthlyRevenue',
  'rent',
  'labor',
  'otherFixed',
  'existingDebt',
  'loanPrincipal',
]);
const formatInput = (key: string, value: string) =>
  moneyFields.has(key) && /^\d+$/.test(value.replaceAll(',', ''))
    ? new Intl.NumberFormat('ko-KR').format(BigInt(value.replaceAll(',', '')))
    : value;

function MoneyInput({
  id,
  label,
  form,
  change,
  help,
}: {
  id: string;
  label: string;
  form: FinanceForm;
  change: (key: string, value: string) => void;
  help?: string;
}) {
  return (
    <label className="field" htmlFor={id}>
      <span>{label}</span>
      <span className="input-wrap">
        <input
          id={id}
          inputMode="numeric"
          value={formatInput(id, form[id])}
          onChange={(event) => change(id, event.target.value.replaceAll(',', ''))}
        />
        <b>원</b>
      </span>
      {help && <small>{help}</small>}
    </label>
  );
}

// 판단 문장. 좋지 않거나 판단하지 못했으면 그 값을 고칠 단계로 보내는 버튼을 붙인다.
function VerdictLine({
  verdict,
  fix,
  onFix,
}: {
  verdict: Verdict | null;
  fix: FixStep;
  onFix: (step: FixStep) => void;
}) {
  if (!verdict) return null;
  return (
    <div className={`verdict verdict-${verdict.tone}`}>
      <p>{verdict.text}</p>
      {verdict.tone !== 'positive' && (
        <button type="button" className="link-button" onClick={() => onFix(fix)}>
          {stepTitle(fix)} 고치기
        </button>
      )}
    </div>
  );
}

// 한 줄에 이름·설명·금액. strong이면 그 묶음의 결론 줄이다.
function LedgerRow({
  label,
  note,
  value,
  strong = false,
}: {
  label: string;
  note?: string;
  value: ValueResult<string>;
  strong?: boolean;
}) {
  const negative = value.status === 'READY' && value.value.startsWith('-');
  return (
    <div className={strong ? 'ledger-total' : undefined}>
      <dt>
        {label}
        {note && <small>{note}</small>}
      </dt>
      <dd className={negative ? 'negative-value' : undefined}>{showValue(value, formatWonText)}</dd>
    </div>
  );
}

const SCENARIO_LABEL = { BASE: '기본', ADVERSE: '악화', IMPROVED: '개선' } as const;

const firstNegativeText = (value: number | null) => (value === null ? '없음' : `${value}개월째`);

// 시나리오 셋을 같은 행에 놓고 비교한다. 행은 항목, 열은 시나리오다.
function ScenarioTable({ scenarios }: { scenarios: ScenarioResult[] }) {
  const moneyRows: Array<{ label: string; pick: (scenario: ScenarioResult) => ValueResult<string> }> = [
    { label: '월 운영수지', pick: (s) => s.monthlyOperatingBalance },
    { label: '운영비 충당 매출', pick: (s) => s.operatingBreakEvenRevenue },
    { label: '상환 포함 균형 매출', pick: (s) => s.debtInclusiveBreakEvenRevenue },
    { label: '첫 달 월 상환액', pick: (s) => s.firstMonthLoanPayment },
    { label: '첫 달 상환 후 잔여현금', pick: (s) => s.firstMonthCashAfterDebtPayment },
  ];
  return (
    <div className="table-scroll full-length">
      <table className="scenario-table">
        <caption className="sr-only">시나리오별 월 운영 결과</caption>
        <thead>
          <tr>
            <th scope="col">항목</th>
            {scenarios.map((scenario) => (
              <th scope="col" key={scenario.name}>
                {SCENARIO_LABEL[scenario.name]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">월매출 가정</th>
            {scenarios.map((scenario) => (
              <td key={scenario.name}>
                {scenario.assumptions.monthlyRevenue === null
                  ? '입력 안 함'
                  : formatWonText(scenario.assumptions.monthlyRevenue)}
              </td>
            ))}
          </tr>
          {moneyRows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              {scenarios.map((scenario) => {
                const value = row.pick(scenario);
                const negative = value.status === 'READY' && value.value.startsWith('-');
                return (
                  <td key={scenario.name} className={negative ? 'negative-value' : undefined}>
                    {showValue(value, formatWonText)}
                  </td>
                );
              })}
            </tr>
          ))}
          <tr>
            <th scope="row">현금이 0원 아래로 가는 달</th>
            {scenarios.map((scenario) => (
              <td key={scenario.name}>{showValue(scenario.firstNegativeCashMonth, firstNegativeText)}</td>
            ))}
          </tr>
        </tbody>
      </table>
      <ul className="scenario-legend">
        {scenarios.map((scenario) => (
          <li key={scenario.name}>
            <strong>{SCENARIO_LABEL[scenario.name]}</strong>
            {scenario.changes.length === 0 ? '입력값 그대로' : scenario.changes.map((c) => c.description).join(', ')}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultView({
  result,
  resultRevision,
  stale,
  history,
  busy,
  cashMonthsField,
  onRecalculate,
  onFix,
}: {
  result: FinanceResult;
  resultRevision: number | null;
  stale: boolean;
  history?: ReactNode;
  busy: boolean;
  cashMonthsField: ReactNode;
  onRecalculate: () => void;
  onFix: (step: FixStep) => void;
}) {
  const base = result.scenarios[0];
  const loanPrincipal: ValueResult<string> =
    result.loan.status === 'READY' ? { status: 'READY', value: result.loan.value.totalPrincipal } : result.loan;
  const months = base.cashBalances.status === 'READY' ? base.cashBalances.value.length : 0;
  // 판단하지 못했으면 처음 빠진 입력이 있는 단계로, 판단했으면 그 판단을 바꿀 단계로 보낸다.
  const fundingFix: FixStep =
    result.fundingPosition.status === 'INSUFFICIENT_INPUT'
      ? stepOfField(result.fundingPosition.missingFields[0] ?? 'equity')
      : 'financing';
  return (
    <section id="results" className="results" tabIndex={-1} aria-live="polite" aria-labelledby="results-title">
      <div className="results-head">
        <h2 id="results-title">계산 결과</h2>
        <p>
          {resultRevision === null
            ? '저장 전 입력으로 계산했습니다.'
            : `${revisionLabel(resultRevision)}한 입력으로 계산했습니다.`}
        </p>
        {stale && (
          <div className="stale-note">
            <p className="inline-error">지금 입력과 다른 이전 계산입니다.</p>
            <button type="button" className="secondary-button" disabled={busy} onClick={onRecalculate}>
              다시 계산
            </button>
          </div>
        )}
      </div>
      {history}

      <div className="result-grid">
        <div className="result-block">
          <h3>개업 자금</h3>
          <VerdictLine verdict={fundingPositionText(result.fundingPosition)} fix={fundingFix} onFix={onFix} />
          <dl className="ledger">
            <LedgerRow
              label="개업 비용 합계"
              note="보증금·시설비·초기 재고·기타 준비비"
              value={result.initialExpenseTotal}
            />
            <LedgerRow
              label="목표 초기 필요자금"
              note="개업 비용 + 목표 운영예비금"
              value={result.targetInitialFunding}
            />
            <LedgerRow label="대출 전 부족액" note="목표 초기 필요자금 − 자기자금" value={result.plannedFundingGap} />
            <LedgerRow label="신규 대출" value={loanPrincipal} />
            <LedgerRow
              label="조달 후 개업 직전 현금"
              note="자기자금 + 신규 대출 − 개업 비용"
              value={result.preOpeningCashAfterFunding}
              strong
            />
            <LedgerRow label="목표 예비금 미달액" value={result.reserveShortfall} />
          </dl>
        </div>

        <div className="result-block">
          <h3>월 운영</h3>
          <VerdictLine
            verdict={revenueVerdict(
              base.assumptions.monthlyRevenue,
              base.operatingBreakEvenRevenue,
              base.debtInclusiveBreakEvenRevenue,
            )}
            fix="operating"
            onFix={onFix}
          />
          <VerdictLine verdict={cashRunwayText(base.firstNegativeCashMonth, months)} fix="operating" onFix={onFix} />
          <ScenarioTable scenarios={result.scenarios} />
        </div>
      </div>

      {/* 현금잔액 표의 기간은 결과를 보는 방법이라 결과 옆에서 바꾼다. 바꾸면 [다시 계산]으로 반영한다. */}
      <div className="result-setting">{cashMonthsField}</div>
      {base.cashBalances.status === 'READY' && (
        <details className="result-details">
          <summary>월별 현금잔액 · 기본 ({months}개월)</summary>
          <div className="table-scroll full-length">
            <table>
              <thead>
                <tr>
                  <th>월</th>
                  <th>신규 대출 상환액</th>
                  <th>상환 후 잔여현금</th>
                  <th>월말 현금잔액</th>
                </tr>
              </thead>
              <tbody>
                {base.cashBalances.value.map((row) => (
                  <tr key={row.month}>
                    <td>{row.month}개월</td>
                    <td>{formatWonText(row.loanPayment)}</td>
                    <td>{formatWonText(row.cashAfterDebtPayment)}</td>
                    <td className={row.closingCashBalance.startsWith('-') ? 'negative-value' : undefined}>
                      {formatWonText(row.closingCashBalance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      <details className="result-details">
        <summary>계산에 넣지 않은 것</summary>
        <p>{result.excludedScope.join(' · ')}</p>
      </details>
    </section>
  );
}

function SectionTitle({ step, note }: { step: PlanStep; note?: string }) {
  return (
    <div className="section-title">
      <span>{stepNumber(step)}</span>
      <div>
        <h2 id={`plan-step-${step}-title`}>{stepTitle(step)}</h2>
        {note && <p className="picker-note">{note}</p>}
      </div>
    </div>
  );
}

// 단계마다 값이 하나라도 들어간 입력란. 단계 목록에 입력한 단계를 표시하는 데 쓴다.
const STEP_FIELDS: Record<InputStep, string[]> = {
  opening: ['deposit', 'facilities', 'initialInventory', 'otherPreparation', 'targetReserve'],
  operating: ['monthlyRevenue', 'rent', 'labor', 'otherFixed', 'variableCostPercent', 'existingDebt'],
  financing: ['equity', 'loanPrincipal', 'annualRatePercent', 'totalMonths', 'graceMonths', 'repaymentMethod'],
};
const LOAN_TERM_FIELDS = ['annualRatePercent', 'totalMonths', 'graceMonths', 'repaymentMethod'];

export type PlannerProps = {
  // 어떤 계획을 보고 있는지. 바뀌면 입력·결과를 initial 값으로 되돌린다. 컴포넌트를 key로 다시 만들지 않는 것은
  // 다른 단계(businessStep 등)에 넣은 사업 조건 입력 단계 같은 상태가 저장할 때마다 처음으로 돌아가지 않게 하려는 것이다.
  resetKey: string;
  initialTitle?: string;
  initialInput?: FinanceInput;
  initialResult?: FinanceResult | null;
  // 보고 있는 결과를 계산한 재무 입력(저장 결과의 inputSnapshot).
  resultInput?: unknown;
  revision?: number | null;
  resultRevision?: number | null;
  busy?: boolean;
  // 보고 있는 단계. 계획을 열 때·저장에 실패할 때 계획 화면도 단계를 정하므로 밖에서 가진다.
  step: PlanStep;
  onStepChange: (step: PlanStep) => void;
  // 재무 입력 밖에서 정하는 단계(01 매장·06 자금 공고)에 값이 들어갔는지.
  businessDone?: boolean;
  fundingDone?: boolean;
  // 월 운영 입력란 위에 보여 줄 출처(예: 상권 점수에서 넘어온 월매출 기본값).
  revenueNotice?: ReactNode;
  // 01 매장 단계의 사업 조건 입력.
  businessStep?: ReactNode;
  // 그 값을 넣을 때 옆에서 볼 참고 자료. 재무 입력에 자동으로 넣지 않는다.
  openingReference?: ReactNode;
  operatingReference?: ReactNode;
  // 06 자금 공고 단계. 공고는 서버에 저장된 조건으로만 찾으므로 계획을 저장하는 함수를 넘겨준다(성공하면 true).
  fundingStep?: (save: () => Promise<boolean>) => ReactNode;
  // 계산 결과 맨 위에 놓을 계산 기록.
  resultHistory?: ReactNode;
  onSave: (title: string, input: FinanceInput) => Promise<unknown>;
  onCalculate: (title: string, input: FinanceInput) => Promise<FinanceResult>;
};

export default function FinancePlanner({
  resetKey,
  initialTitle = '',
  initialInput,
  initialResult = null,
  resultInput,
  revision = null,
  resultRevision = null,
  busy = false,
  step,
  onStepChange,
  businessDone = false,
  fundingDone = false,
  revenueNotice,
  businessStep,
  openingReference,
  operatingReference,
  fundingStep,
  resultHistory,
  onSave,
  onCalculate,
}: PlannerProps) {
  const [form, setForm] = useState(() => fromInput(initialInput));
  const [title, setTitle] = useState(initialTitle);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<FinanceResult | null>(initialResult);
  const [dirty, setDirty] = useState(false);
  const [loadedKey, setLoadedKey] = useState(resetKey);
  const stepListRef = useRef<HTMLOListElement>(null);
  if (loadedKey !== resetKey) {
    setLoadedKey(resetKey);
    setForm(fromInput(initialInput));
    setTitle(initialTitle);
    setResult(initialResult);
    setErrors([]);
    setDirty(false);
  }
  useEffect(() => {
    const timer = window.setTimeout(() => setResult(initialResult), 0);
    return () => window.clearTimeout(timer);
  }, [initialResult]);
  // 좁은 화면에서 단계 목록이 가로로 넘치면 지금 단계가 보이게 목록만 옆으로 넘긴다.
  useEffect(() => {
    const list = stepListRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !current || list.scrollWidth <= list.clientWidth) return;
    list.scrollTo({ left: current.offsetLeft - list.offsetLeft - 8 });
  }, [step]);
  const change = (key: string, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };
  // 단계를 바꾸면 단계 목록이 화면 위로 지나갔을 때만 그 자리로 올린다. focusInput이면 첫 입력란에 커서를 둔다.
  function go(next: PlanStep, focusInput = false) {
    onStepChange(next);
    requestAnimationFrame(() => {
      const steps = document.getElementById('plan-steps');
      if (steps && steps.getBoundingClientRect().top < 0) steps.scrollIntoView({ block: 'start' });
      if (focusInput)
        document
          .getElementById(`plan-step-${next}`)
          ?.querySelector<HTMLElement>('input, select')
          ?.focus({ preventScroll: true });
    });
  }
  const validate = () => {
    if (!title.trim()) {
      setErrors(['계획 제목을 입력해 주세요.']);
      document.getElementById('plan-title')?.focus();
      return null;
    }
    const parsed = financeInputSchema.safeParse(toInput(form));
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((issue) => `${fieldLabel(issue.path.join('.'))}: ${issue.message}`));
      // 첫 오류가 있는 단계로 옮겨, 고칠 입력란이 보이게 한다.
      go(stepOfField(parsed.error.issues[0].path.join('.')));
      return null;
    }
    setErrors([]);
    return parsed.data;
  };
  // 저장·계산 실패는 상위 화면이 사용자 메시지로 표시한다. 여기서 잡아 처리되지 않은
  // 거부가 개발 오버레이에 오류로 남지 않게 한다.
  async function save(): Promise<boolean> {
    const input = validate();
    if (!input) return false;
    try {
      await onSave(title.trim(), input);
      setDirty(false);
      return true;
    } catch {
      /* 상위 화면이 표시한다. */
      return false;
    }
  }
  async function calculate() {
    const input = validate();
    if (!input) return;
    try {
      const next = await onCalculate(title.trim(), input);
      setResult(next);
      setDirty(false);
      go('result');
    } catch {
      /* 상위 화면이 표시한다. */
    }
  }
  // 결과가 지금 재무 입력으로 계산한 것인지는 결과의 입력 스냅샷과 견준다. 제목·사업 조건·자금 조건만 저장해도 저장 번호가
  // 오르므로 번호로 견주면 같은 입력의 결과를 이전 값이라고 잘못 알린다. 스냅샷이 없을 때만 저장 번호로 견준다.
  const sameInput = result ? sameAsCalculatedInput(form, resultInput) : null;
  const stale =
    sameInput === null
      ? dirty || (resultRevision !== null && revision !== null && resultRevision !== revision)
      : !sameInput;
  const index = stepIndex(step);
  const prev = index > 0 ? PLAN_STEPS[index - 1] : null;
  const next = index < PLAN_STEPS.length - 1 ? PLAN_STEPS[index + 1] : null;
  const filled = (keys: string[]) => keys.some((key) => (form[key] ?? '').trim() !== '');
  const done: Record<PlanStep, boolean> = {
    business: businessDone,
    opening: filled(STEP_FIELDS.opening),
    operating: filled(STEP_FIELDS.operating),
    financing: filled(STEP_FIELDS.financing),
    result: result !== null,
    funding: fundingDone,
  };
  // 신규 대출금이 비었거나 0이면 무차입으로 계산하므로 대출 조건을 묻지 않는다. 이미 넣은 조건이 있으면 지우지 않고 보여 준다.
  const principal = form.loanPrincipal.replaceAll(',', '').trim();
  const showLoanTerms = (principal !== '' && principal !== '0') || filled(LOAN_TERM_FIELDS);

  const panel = (key: PlanStep, content: ReactNode) => (
    <div
      className="plan-step-panel"
      id={`plan-step-${key}`}
      role="group"
      aria-labelledby={`plan-step-${key}-title`}
      hidden={step !== key}
    >
      {content}
    </div>
  );

  const cashMonthsField = (
    <label className="field" htmlFor="cashBalanceMonths">
      <span>현금잔액 계산기간</span>
      <span className="input-wrap">
        <input
          id="cashBalanceMonths"
          inputMode="numeric"
          value={form.cashBalanceMonths}
          onChange={(e) => change('cashBalanceMonths', e.target.value)}
        />
        <b>개월</b>
      </span>
      <small>바꾸면 [다시 계산]을 눌러 반영하세요.</small>
    </label>
  );

  return (
    <div className="planner">
      {/* 계획 이름과 단계 목록을 한 카드에 둬, 단계 내용이 첫 화면에 더 많이 보이게 한다. */}
      <section className="plan-head">
        <div className="plan-head-row">
          <div className="plan-head-title">
            <h1>재무 계획</h1>
            <p>입력한 숫자로만 계산합니다. 상권·시세 자료는 자동으로 들어가지 않습니다.</p>
          </div>
          <label className="field" htmlFor="plan-title">
            <span>계획 제목</span>
            <span className="input-wrap">
              <input
                id="plan-title"
                className="text-input"
                maxLength={100}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setDirty(true);
                }}
              />
            </span>
          </label>
        </div>
        <nav className="plan-steps" id="plan-steps" aria-label="계획 단계">
          <ol ref={stepListRef}>
            {PLAN_STEPS.map((item) => {
              const current = step === item.key;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    className={done[item.key] ? 'plan-step done' : 'plan-step'}
                    aria-current={current ? 'step' : undefined}
                    onClick={() => go(item.key)}
                  >
                    <span aria-hidden="true">{done[item.key] && !current ? '✓' : stepNumber(item.key)}</span>
                    {item.title}
                    {done[item.key] && <em className="sr-only">(입력함)</em>}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </section>

      {panel(
        'business',
        <>
          <h2 className="sr-only" id="plan-step-business-title">
            매장
          </h2>
          <p className="step-note">
            비워 둬도 계산할 수 있습니다. 고르면 02 개업 비용과 03 월 운영에 시세 참고가 나옵니다.
          </p>
          {businessStep}
        </>,
      )}

      {panel(
        'opening',
        <div className="step-layout">
          <section className="form-section">
            <SectionTitle step="opening" note="문을 열기 전까지 드는 돈과, 매출이 자리 잡을 때까지 버틸 돈입니다." />
            <div className="field-grid">
              <MoneyInput id="deposit" label="보증금" form={form} change={change} />
              <MoneyInput id="facilities" label="시설비" form={form} change={change} />
              <MoneyInput id="initialInventory" label="초기 재고" form={form} change={change} />
              <MoneyInput id="otherPreparation" label="기타 준비비" form={form} change={change} />
              <MoneyInput id="targetReserve" label="목표 운영예비금" form={form} change={change} />
            </div>
          </section>
          <aside className="step-aside">{openingReference}</aside>
        </div>,
      )}

      {panel(
        'operating',
        <div className="step-layout">
          <section className="form-section">
            <SectionTitle step="operating" note="문을 연 뒤 한 달에 들어오고 나가는 돈입니다." />
            {revenueNotice}
            <div className="field-grid">
              <MoneyInput
                id="monthlyRevenue"
                label="월매출 가정 (선택)"
                form={form}
                change={change}
                help="비워 두면 초기 자금만 계산합니다."
              />
              <MoneyInput id="rent" label="월 임대료" form={form} change={change} />
              <MoneyInput id="labor" label="월 인건비" form={form} change={change} />
              <MoneyInput id="otherFixed" label="기타 월 고정비" form={form} change={change} />
              <label className="field" htmlFor="variableCostPercent">
                <span>매출 대비 변동비율</span>
                <span className="input-wrap">
                  <input
                    id="variableCostPercent"
                    inputMode="decimal"
                    value={form.variableCostPercent}
                    onChange={(e) => change('variableCostPercent', e.target.value)}
                  />
                  <b>%</b>
                </span>
                <small>재료비·포장재·카드 수수료처럼 매출이 늘면 함께 느는 비용이 매출에서 차지하는 비율입니다.</small>
              </label>
              <MoneyInput
                id="existingDebt"
                label="기존 월 상환액"
                form={form}
                change={change}
                help="없으면 0을 넣으세요."
              />
            </div>
          </section>
          <aside className="step-aside">{operatingReference}</aside>
        </div>,
      )}

      {panel(
        'financing',
        <section className="form-section">
          <SectionTitle step="financing" note="가진 돈과 빌릴 돈입니다. 자금 공고는 결과를 본 뒤에 찾습니다." />
          <div className="field-grid">
            <MoneyInput id="equity" label="자기자금" form={form} change={change} />
            <MoneyInput
              id="loanPrincipal"
              label="신규 대출금"
              form={form}
              change={change}
              help={showLoanTerms ? undefined : '빌리지 않으면 비워 두세요. 넣으면 대출 조건을 묻습니다.'}
            />
            {showLoanTerms && (
              <>
                <label className="field" htmlFor="annualRatePercent">
                  <span>연 금리</span>
                  <span className="input-wrap">
                    <input
                      id="annualRatePercent"
                      inputMode="decimal"
                      value={form.annualRatePercent}
                      onChange={(e) => change('annualRatePercent', e.target.value)}
                    />
                    <b>%</b>
                  </span>
                </label>
                <label className="field" htmlFor="totalMonths">
                  <span>전체 상환개월</span>
                  <span className="input-wrap">
                    <input
                      id="totalMonths"
                      inputMode="numeric"
                      value={form.totalMonths}
                      onChange={(e) => change('totalMonths', e.target.value)}
                    />
                    <b>개월</b>
                  </span>
                </label>
                <label className="field" htmlFor="graceMonths">
                  <span>원금 거치개월</span>
                  <span className="input-wrap">
                    <input
                      id="graceMonths"
                      inputMode="numeric"
                      value={form.graceMonths}
                      onChange={(e) => change('graceMonths', e.target.value)}
                    />
                    <b>개월</b>
                  </span>
                </label>
                <label className="field" htmlFor="repaymentMethod">
                  <span>상환방식</span>
                  <select
                    id="repaymentMethod"
                    value={form.repaymentMethod}
                    onChange={(e) => change('repaymentMethod', e.target.value)}
                  >
                    <option value="">선택하지 않음</option>
                    <option value="EQUAL_PAYMENT">원리금균등</option>
                    <option value="EQUAL_PRINCIPAL">원금균등</option>
                  </select>
                </label>
              </>
            )}
          </div>
        </section>,
      )}

      {panel(
        'result',
        result && result.scenarios[0] ? (
          <ResultView
            result={result}
            resultRevision={resultRevision}
            stale={stale}
            history={resultHistory}
            busy={busy}
            cashMonthsField={cashMonthsField}
            onRecalculate={() => void calculate()}
            onFix={(fix) => go(fix, true)}
          />
        ) : (
          <section className="empty-panel" aria-labelledby="plan-step-result-title">
            <h2 id="plan-step-result-title">아직 계산하지 않았습니다</h2>
            <p>
              개업 비용·월 운영·자금 마련을 넣고 계산하면 여기에 결과가 나옵니다. 비운 항목은 결과에 이유를 적습니다.
            </p>
            <button type="button" disabled={busy} onClick={() => void calculate()}>
              {busy ? '계산 중…' : '계산하고 결과 보기'}
            </button>
          </section>
        ),
      )}

      {panel(
        'funding',
        <>
          <h2 className="sr-only" id="plan-step-funding-title">
            자금 공고
          </h2>
          {fundingStep?.(save)}
        </>,
      )}

      {errors.length > 0 && (
        <section id="validation-errors" className="error-box" tabIndex={-1} aria-live="assertive">
          <h2>입력을 확인해 주세요</h2>
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </section>
      )}
      {/* 단계 이동은 화면에 붙어 따라오는 이 막대에서만 한다. 기본 버튼은 늘 하나다. */}
      <div className="calculate-bar">
        <div className="draft-state" aria-live="polite">
          <strong>{revision === null ? '저장 안 됨' : dirty ? '저장하지 않은 변경이 있습니다' : '저장됨'}</strong>
          {stale && result && <span>입력이 바뀌어 결과가 이전 값입니다. 다시 계산하세요.</span>}
        </div>
        <div className="button-row">
          {prev && (
            <button className="secondary-button" type="button" onClick={() => go(prev.key)}>
              이전
            </button>
          )}
          <button className="secondary-button" type="button" disabled={busy} onClick={() => void save()}>
            초안 저장
          </button>
          {step === 'financing' ? (
            <button type="button" disabled={busy} onClick={() => void calculate()}>
              {busy ? '계산 중…' : '계산하고 결과 보기'}
            </button>
          ) : (
            next && (
              // 01 매장에서는 사업 조건 입력의 [다음]이 기본 버튼이다. 다 채우기 전에는 건너뛰는 버튼으로 낮춰 둔다.
              <button
                type="button"
                className={step === 'business' && !businessDone ? 'secondary-button' : undefined}
                onClick={() => go(next.key)}
              >
                다음: {next.title}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
