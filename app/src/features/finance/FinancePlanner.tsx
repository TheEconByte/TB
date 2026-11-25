'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { fromInput, toInput, type FinanceForm } from './form';
import { financeInputSchema } from './schema';
import { revisionLabel } from '@/lib/revision-text';
import type { FinanceInput, FinanceResult, ScenarioResult, ValueResult } from './types';

const labels: Record<string, string> = {
  'openingExpenses.deposit': '보증금',
  'openingExpenses.facilities': '시설비',
  'openingExpenses.initialInventory': '초기 재고',
  'openingExpenses.otherPreparation': '기타 준비비',
  targetReserve: '목표 운영예비금',
  equity: '자기자금',
  monthlyRevenue: '월매출 가정',
  'monthlyFixedCosts.rent': '월 임대료',
  'monthlyFixedCosts.labor': '월 인건비',
  'monthlyFixedCosts.other': '기타 월 고정비',
  variableCostRate: '변동비율',
  existingMonthlyDebtPayment: '기존 월 상환액',
  'newLoan.principal': '신규 대출금',
  'newLoan.annualInterestRatePercent': '연 금리',
  'newLoan.totalMonths': '전체 상환개월',
  'newLoan.graceMonths': '원금 거치개월',
  'newLoan.repaymentMethod': '상환방식',
  cashBalanceMonths: '현금잔액 계산기간',
};
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
export const formatWon = (value: string) => `${new Intl.NumberFormat('ko-KR').format(BigInt(value))}원`;

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
// 저장 결과 값을 화면 문구로 바꾼다. 계산하지 못한 값은 0으로 두지 않고 이유를 적는다.
export function showValue<T>(result: ValueResult<T>, render: (value: T) => string) {
  if (result.status === 'READY') return render(result.value);
  return result.status === 'UNSUPPORTED'
    ? `계산 불가 · ${result.reason}`
    : `입력 필요 · ${result.missingFields.map((field) => labels[field] ?? field).join(', ')}`;
}
const scenarioLabel = { BASE: '기본', ADVERSE: '악화', IMPROVED: '개선' };
function ScenarioCard({ scenario }: { scenario: ScenarioResult }) {
  return (
    <article className="scenario-card">
      <div className="scenario-heading">
        <h3>{scenarioLabel[scenario.name]}</h3>
        <span>{scenario.name === 'BASE' ? '입력값 그대로' : '입력값을 바꿔 본 경우'}</span>
      </div>
      {scenario.changes.length > 0 && (
        <ul className="changes">
          {scenario.changes.map((change) => (
            <li key={change.field}>{change.description}</li>
          ))}
        </ul>
      )}
      <dl>
        <div>
          <dt>월 운영수지</dt>
          <dd>{showValue(scenario.monthlyOperatingBalance, formatWon)}</dd>
        </div>
        <div>
          <dt>운영비 충당 매출</dt>
          <dd>{showValue(scenario.operatingBreakEvenRevenue, formatWon)}</dd>
        </div>
        <div>
          <dt>상환 포함 균형 매출</dt>
          <dd>{showValue(scenario.debtInclusiveBreakEvenRevenue, formatWon)}</dd>
        </div>
        <div>
          <dt>첫 달 월 상환액</dt>
          <dd>{showValue(scenario.firstMonthLoanPayment, formatWon)}</dd>
        </div>
        <div>
          <dt>첫 달 상환 후 잔여현금</dt>
          <dd>{showValue(scenario.firstMonthCashAfterDebtPayment, formatWon)}</dd>
        </div>
      </dl>
    </article>
  );
}

export type PlannerProps = {
  // 어떤 계획을 보고 있는지. 바뀌면 입력·결과를 initial 값으로 되돌린다. 컴포넌트를 key로 다시 만들지 않는 것은
  // 아래 자리(references 등)에 넣은 사업 조건 입력 단계 같은 상태가 저장할 때마다 처음으로 돌아가지 않게 하려는 것이다.
  resetKey: string;
  initialTitle?: string;
  initialInput?: FinanceInput;
  initialResult?: FinanceResult | null;
  revision?: number | null;
  resultRevision?: number | null;
  busy?: boolean;
  // 월 운영 가정 입력란 위에 보여 줄 출처(예: 상권 점수에서 넘어온 월매출 기본값).
  revenueNotice?: ReactNode;
  // 계획 머리와 재무 입력 사이에 놓을 입력(사업 조건).
  businessInputs?: ReactNode;
  // 계산 결과 옆(넓은 화면)이나 아래(좁은 화면)에 놓을 시세 참고.
  references?: ReactNode;
  // 재무 입력 아래, 저장 버튼 위에 놓을 입력(자금 조건). [초안 저장]이 함께 저장하는 입력은 모두 버튼 위에 둔다.
  extraInputs?: ReactNode;
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
  revision = null,
  resultRevision = null,
  busy = false,
  revenueNotice,
  businessInputs,
  references,
  extraInputs,
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
  const change = (key: string, value: string) => {
    setForm((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };
  const validate = () => {
    if (!title.trim()) {
      setErrors(['계획 제목을 입력해 주세요.']);
      return null;
    }
    const parsed = financeInputSchema.safeParse(toInput(form));
    if (!parsed.success) {
      setErrors(
        parsed.error.issues.map((issue) => `${labels[issue.path.join('.')] ?? issue.path.join('.')}: ${issue.message}`),
      );
      requestAnimationFrame(() => document.querySelector<HTMLElement>('#validation-errors')?.focus());
      return null;
    }
    setErrors([]);
    return parsed.data;
  };
  // 저장·계산 실패는 상위 화면이 사용자 메시지로 표시한다. 여기서 잡아 처리되지 않은
  // 거부가 개발 오버레이에 오류로 남지 않게 한다.
  async function save() {
    const input = validate();
    if (!input) return;
    try {
      await onSave(title.trim(), input);
      setDirty(false);
    } catch {
      /* 상위 화면이 표시한다. */
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = validate();
    if (!input) return;
    try {
      const next = await onCalculate(title.trim(), input);
      setResult(next);
      setDirty(false);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('#results')?.focus());
    } catch {
      /* 상위 화면이 표시한다. */
    }
  }
  const base = result?.scenarios[0];
  const stale = dirty || (resultRevision !== null && revision !== null && resultRevision !== revision);
  // 넓은 화면에서는 입력과 결과·참고를 두 열로 나눠, 입력을 고치면서 결과를 옆에서 본다(globals.css .planner-layout).
  return (
    <div className="planner-layout">
      <div className="planner-inputs">
        <section className="plan-head">
          <h1>재무 계획</h1>
          <p>입력한 숫자로만 계산합니다. 상권·시세 자료는 자동으로 들어가지 않습니다.</p>
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
        </section>
        {businessInputs}
        <form id="finance-form" onSubmit={submit} noValidate>
          <section className="form-section">
            <div className="section-title">
              <span>01</span>
              <div>
                <h2>개업 전 자금</h2>
              </div>
            </div>
            <div className="field-grid">
              <MoneyInput id="deposit" label="보증금" form={form} change={change} />
              <MoneyInput id="facilities" label="시설비" form={form} change={change} />
              <MoneyInput id="initialInventory" label="초기 재고" form={form} change={change} />
              <MoneyInput id="otherPreparation" label="기타 준비비" form={form} change={change} />
              <MoneyInput id="targetReserve" label="목표 운영예비금" form={form} change={change} />
              <MoneyInput id="equity" label="자기자금" form={form} change={change} />
            </div>
          </section>
          <section className="form-section">
            <div className="section-title">
              <span>02</span>
              <div>
                <h2>월 운영 가정</h2>
              </div>
            </div>
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
          <section className="form-section">
            <div className="section-title">
              <span>03</span>
              <div>
                <h2>신규 대출 가정</h2>
              </div>
            </div>
            <div className="field-grid">
              <MoneyInput id="loanPrincipal" label="신규 대출금" form={form} change={change} />
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
              </label>
            </div>
          </section>
        </form>
        {extraInputs}
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
        <div className="calculate-bar">
          <div className="draft-state" aria-live="polite">
            <strong>
              {revision === null
                ? '저장 안 됨'
                : dirty
                  ? `${revisionLabel(revision)} 뒤 수정함`
                  : `${revisionLabel(revision)}함`}
            </strong>
            {stale && result && <span>입력이 바뀌어 아래 결과는 이전 값입니다. 다시 계산하세요.</span>}
          </div>
          <div className="button-row">
            {result && (
              <a className="link-button" href="#results">
                결과 보기
              </a>
            )}
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void save()}>
              초안 저장
            </button>
            <button type="submit" form="finance-form" disabled={busy}>
              {busy ? '계산 중…' : '저장하고 계산'}
            </button>
          </div>
        </div>
      </div>
      <div className="planner-side">
        {result && base && (
          <section id="results" className="results" tabIndex={-1} aria-live="polite">
            <div className="results-head">
              <h2>계산 결과 · {resultRevision === null ? '저장 전 입력' : `${revisionLabel(resultRevision)} 기준`}</h2>
            </div>
            {resultHistory}
            <div className="summary-grid">
              <div>
                <span>목표 초기 필요자금</span>
                <strong>{showValue(result.targetInitialFunding, formatWon)}</strong>
              </div>
              <div>
                <span>계획상 부족자금</span>
                <strong>{showValue(result.plannedFundingGap, formatWon)}</strong>
              </div>
              <div>
                <span>조달 후 개업 직전 현금</span>
                <strong>{showValue(result.preOpeningCashAfterFunding, formatWon)}</strong>
              </div>
              <div>
                <span>목표 예비금 미달액</span>
                <strong>{showValue(result.reserveShortfall, formatWon)}</strong>
              </div>
            </div>
            <div className="scenario-grid">
              {result.scenarios.map((scenario) => (
                <ScenarioCard key={scenario.name} scenario={scenario} />
              ))}
            </div>
            {base.cashBalances.status === 'READY' && (
              <div className="table-card">
                <h3>기본 가정 · 현금잔액</h3>
                <div className="table-scroll">
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
                          <td>{formatWon(row.loanPayment)}</td>
                          <td>{formatWon(row.cashAfterDebtPayment)}</td>
                          <td>{formatWon(row.closingCashBalance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            <aside className="scope-note">
              <h3>계산에 넣지 않은 것</h3>
              <p>{result.excludedScope.join(' · ')}</p>
            </aside>
          </section>
        )}
        {references}
      </div>
    </div>
  );
}
