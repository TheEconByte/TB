'use client';

import Decimal from 'decimal.js';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { financeInputSchema } from './schema';
import type { FinanceInput, FinanceResult, ScenarioResult, ValueResult } from './types';

type FormState = Record<string, string>;
const defaults: FormState = {
  deposit: '30000000',
  facilities: '40000000',
  initialInventory: '5000000',
  otherPreparation: '5000000',
  targetReserve: '10000000',
  equity: '40000000',
  monthlyRevenue: '20000000',
  rent: '3000000',
  labor: '3000000',
  otherFixed: '1000000',
  variableCostPercent: '35',
  existingDebt: '0',
  loanPrincipal: '50000000',
  annualRatePercent: '5',
  totalMonths: '60',
  graceMonths: '0',
  repaymentMethod: 'EQUAL_PAYMENT',
  cashBalanceMonths: '12',
};
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
const nullable = (value: string) => (value.trim() === '' ? null : value.replaceAll(',', '').trim());
const integerOrNull = (value: string) => (value.trim() === '' ? null : Number(value));
const percentToRatio = (value: string) => {
  if (!value.trim()) return null;
  try {
    return new Decimal(value).div(100).toString();
  } catch {
    return value;
  }
};
const formatInput = (key: string, value: string) =>
  moneyFields.has(key) && /^\d+$/.test(value.replaceAll(',', ''))
    ? new Intl.NumberFormat('ko-KR').format(BigInt(value.replaceAll(',', '')))
    : value;
const formatWon = (value: string) => `${new Intl.NumberFormat('ko-KR').format(BigInt(value))}원`;

export function toInput(form: FormState): FinanceInput {
  return {
    openingExpenses: {
      deposit: nullable(form.deposit),
      facilities: nullable(form.facilities),
      initialInventory: nullable(form.initialInventory),
      otherPreparation: nullable(form.otherPreparation),
    },
    targetReserve: nullable(form.targetReserve),
    equity: nullable(form.equity),
    monthlyRevenue: nullable(form.monthlyRevenue),
    monthlyFixedCosts: { rent: nullable(form.rent), labor: nullable(form.labor), other: nullable(form.otherFixed) },
    variableCostRate: percentToRatio(form.variableCostPercent),
    existingMonthlyDebtPayment: nullable(form.existingDebt),
    newLoan: {
      principal: nullable(form.loanPrincipal),
      annualInterestRatePercent: nullable(form.annualRatePercent),
      totalMonths: integerOrNull(form.totalMonths),
      graceMonths: integerOrNull(form.graceMonths),
      repaymentMethod: form.repaymentMethod
        ? (form.repaymentMethod as FinanceInput['newLoan']['repaymentMethod'])
        : null,
    },
    cashBalanceMonths: Number(form.cashBalanceMonths),
  };
}

function fromInput(input?: FinanceInput): FormState {
  if (!input) return defaults;
  return {
    deposit: input.openingExpenses.deposit ?? '',
    facilities: input.openingExpenses.facilities ?? '',
    initialInventory: input.openingExpenses.initialInventory ?? '',
    otherPreparation: input.openingExpenses.otherPreparation ?? '',
    targetReserve: input.targetReserve ?? '',
    equity: input.equity ?? '',
    monthlyRevenue: input.monthlyRevenue ?? '',
    rent: input.monthlyFixedCosts.rent ?? '',
    labor: input.monthlyFixedCosts.labor ?? '',
    otherFixed: input.monthlyFixedCosts.other ?? '',
    variableCostPercent: input.variableCostRate === null ? '' : new Decimal(input.variableCostRate).mul(100).toString(),
    existingDebt: input.existingMonthlyDebtPayment ?? '',
    loanPrincipal: input.newLoan.principal ?? '',
    annualRatePercent: input.newLoan.annualInterestRatePercent ?? '',
    totalMonths: input.newLoan.totalMonths?.toString() ?? '',
    graceMonths: input.newLoan.graceMonths?.toString() ?? '',
    repaymentMethod: input.newLoan.repaymentMethod ?? '',
    cashBalanceMonths: input.cashBalanceMonths.toString(),
  };
}

function MoneyInput({
  id,
  label,
  form,
  change,
  help,
}: {
  id: string;
  label: string;
  form: FormState;
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
function showValue<T>(result: ValueResult<T>, render: (value: T) => string) {
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
        <span>{scenario.name === 'BASE' ? '입력한 원래 가정' : '스트레스 가정'}</span>
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
  initialTitle?: string;
  initialInput?: FinanceInput;
  initialResult?: FinanceResult | null;
  revision?: number | null;
  resultRevision?: number | null;
  busy?: boolean;
  // 계획 화면이 상품 확정 조건을 대출 가정으로 적용했을 때 폼을 저장된 입력으로 다시
  // 채우기 위한 신호. 값이 바뀌면 폼을 현재 저장된 입력으로 되돌린다.
  syncToken?: number;
  // 재무 입력에 저장하지 않은 변경이 있는지 상위 화면에 알린다. 상품 조건 적용은
  // 저장된 초안을 바꾸는 일이므로 저장되지 않은 편집이 있으면 막아야 한다.
  onDirtyChange?: (dirty: boolean) => void;
  onSave: (title: string, input: FinanceInput) => Promise<unknown>;
  onCalculate: (title: string, input: FinanceInput) => Promise<FinanceResult>;
};

export default function FinancePlanner({
  initialTitle = '',
  initialInput,
  initialResult = null,
  revision = null,
  resultRevision = null,
  busy = false,
  syncToken,
  onDirtyChange,
  onSave,
  onCalculate,
}: PlannerProps) {
  const [form, setForm] = useState(() => fromInput(initialInput));
  const [title, setTitle] = useState(initialTitle);
  const [errors, setErrors] = useState<string[]>([]);
  const [result, setResult] = useState<FinanceResult | null>(initialResult);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setResult(initialResult), 0);
    return () => window.clearTimeout(timer);
  }, [initialResult]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const syncedToken = useRef(syncToken);
  useEffect(() => {
    if (syncToken === undefined || syncedToken.current === syncToken) return;
    syncedToken.current = syncToken;
    setForm(fromInput(initialInput));
    setTitle(initialTitle);
    setErrors([]);
    setDirty(false);
  }, [syncToken, initialInput, initialTitle]);
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
  return (
    <>
      <section className="hero">
        <p className="eyebrow">로그인 계정에 보존하는 재무계획</p>
        <h1>
          내 가정으로 확인하는
          <br />
          창업 재무계획
        </h1>
        <p>초안을 저장한 뒤 서버에서 계산합니다. 과거 결과는 입력을 바꿔도 그대로 남습니다.</p>
      </section>
      <form onSubmit={submit} noValidate>
        <section className="form-section">
          <div className="section-title">
            <span>00</span>
            <div>
              <h2>계획 이름</h2>
              <p>내 계획 목록에서 다시 찾을 이름입니다.</p>
            </div>
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
        </section>
        <section className="form-section">
          <div className="section-title">
            <span>01</span>
            <div>
              <h2>개업 전 자금</h2>
              <p>실제 지출과 남겨 둘 예비금을 구분합니다.</p>
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
              <p>공공 상권 매출이 아닌 사용자 가정입니다.</p>
            </div>
          </div>
          <div className="field-grid">
            <MoneyInput
              id="monthlyRevenue"
              label="월매출 가정 (선택)"
              form={form}
              change={change}
              help="모르면 비워도 초기 자금 결과는 계산됩니다."
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
            <MoneyInput id="existingDebt" label="기존 월 상환액" form={form} change={change} />
          </div>
        </section>
        <section className="form-section">
          <div className="section-title">
            <span>03</span>
            <div>
              <h2>신규 대출 가정</h2>
              <p>부족자금이 자동 입력되지 않습니다.</p>
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
        <div className="draft-state" aria-live="polite">
          <strong>
            {revision === null
              ? '저장되지 않은 새 입력'
              : dirty
                ? `저장 이후 입력 변경 · 초안 revision ${revision}`
                : `저장된 최신 초안 · revision ${revision}`}
          </strong>
          {stale && result && <span>결과 생성 후 입력이 변경되었습니다. 다시 계산해 주세요.</span>}
        </div>
        <div className="calculate-bar">
          <div>
            <strong>{busy ? '서버에서 처리하고 있습니다.' : '초안 저장과 서버 계산을 구분합니다.'}</strong>
            <span>계산은 저장된 입력을 서버에서 다시 검증합니다.</span>
          </div>
          <div className="button-row">
            <button className="secondary-button" type="button" disabled={busy} onClick={() => void save()}>
              초안 저장
            </button>
            <button type="submit" disabled={busy}>
              {busy ? '계산 중…' : '저장하고 서버 계산'}
            </button>
          </div>
        </div>
      </form>
      {result && base && (
        <section id="results" className="results" tabIndex={-1} aria-live="polite">
          <div className="results-head">
            <p className="eyebrow">저장된 계산 결과</p>
            <h2>revision {resultRevision}의 불변 결과</h2>
            <p>계산 시점 입력 스냅샷으로 만든 결과입니다.</p>
          </div>
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
            <h3>계산에 포함되지 않은 범위</h3>
            <p>{result.excludedScope.join(' · ')}</p>
            <small>
              입력 {result.inputSchemaVersion} · 계산 {result.calculationVersion}
            </small>
          </aside>
        </section>
      )}
    </>
  );
}
