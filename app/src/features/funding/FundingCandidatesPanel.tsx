'use client';

import type { FundingCandidatesResponse } from './candidates.ts';
import { districtName } from './districts.ts';
import {
  purposeLabel,
  stageLabel,
  type FundingCandidateEvaluation,
  type FundingCandidateStatus,
  type FundingProfile,
} from './eligibility.ts';
import type { ObservedApplicationStatus, ReviewState, SupportType, Verdict } from './types.ts';

// 페이지 단위 입력(/funding)과 저장된 계획 조건(/plans)이 같은 판정 결과를 같은
// 모양으로 보여주도록 결과 표시를 한 곳에 둔다. 두 화면은 조회 진입점만 다르다.

const numberFormat = new Intl.NumberFormat('ko-KR');

// 지원 유형은 대출과 다른 성격을 이름부터 구분한다. GRANT·SPACE·PROGRAM을
// 대출처럼 보이게 하는 표현을 쓰지 않는다.
const SUPPORT_TYPE_LABELS: Record<SupportType, string> = {
  GRANT: '지원금(상환 없음)',
  GUARANTEE: '보증(대출 아님)',
  LOAN: '대출(상환 대상)',
  SPACE: '공간·보육(대출 아님)',
  PROGRAM: '프로그램(대출 아님)',
};

const STATUS_LABELS: Record<FundingCandidateStatus, string> = {
  CURRENT_CANDIDATE: '검토 후보',
  NEEDS_CONFIRMATION: '추가 확인 필요',
  NOT_ELIGIBLE: '조건 미충족',
  POST_REGISTRATION: '사업자등록 이후 검토',
  CLOSED: '접수 종료',
  REVIEW_OVERDUE: '검수 기한 경과',
};

const VERDICT_LABELS: Record<Verdict, string> = { PASS: '충족', FAIL: '미충족', UNKNOWN: '미확인' };

const APPLICATION_STATUS_LABELS: Record<ObservedApplicationStatus, string> = {
  OPEN: '접수 중으로 확인',
  CLOSED: '접수 종료로 확인',
  UNKNOWN: '접수 상태 미확인',
};

const REVIEW_STATE_LABELS: Record<ReviewState, string> = {
  CURRENT: '검수 최신',
  UNREVIEWED: '검수자 미지정',
  REVIEW_OVERDUE: '검수 기한 경과',
};

// 결과는 현재 후보와 그렇지 않은 상태를 섞지 않고 나눠서 보여준다.
const GROUPS: { status: FundingCandidateStatus; title: string; note: string; separated: boolean }[] = [
  {
    status: 'CURRENT_CANDIDATE',
    title: '현재 검토 후보',
    note: '확인된 조건이 모두 충족되고 접수 중으로 확인된 상품입니다. 승인 확정이 아닙니다.',
    separated: false,
  },
  {
    status: 'NEEDS_CONFIRMATION',
    title: '추가 확인 필요',
    note: '확인되지 않은 조건, 원문 근거 부족, 검수 미완료 중 하나 이상이 있습니다.',
    separated: false,
  },
  {
    status: 'NOT_ELIGIBLE',
    title: '조건 미충족',
    note: '명확히 미충족인 조건이 있어 대상이 아닙니다.',
    separated: false,
  },
  {
    status: 'POST_REGISTRATION',
    title: '사업자등록 이후 검토',
    note: '예비 창업자가 아니라 사업자등록 이후에만 검토할 수 있어 현재 후보와 분리합니다.',
    separated: true,
  },
  {
    status: 'CLOSED',
    title: '접수 종료',
    note: '관측 시점에 접수가 종료되어 현재 신청할 수 없습니다.',
    separated: true,
  },
  {
    status: 'REVIEW_OVERDUE',
    title: '검수 기한 경과',
    note: '다음 검토일이 지나 재확인 전에는 현재 후보로 표시하지 않습니다.',
    separated: true,
  },
];

export type FundingLoadError = { code: string | null; message: string };

// 응답이 우리 API에서 온 것이면 한국어 메시지가 있고, 네트워크 실패면 없다.
// 브라우저의 'Failed to fetch' 대신 확인할 수 있는 문장을 보여준다.
export function describeFundingError(error: unknown): FundingLoadError {
  const typed = error as Error & { code?: string };
  if (typed && typeof typed.message === 'string' && typed.message.length > 0 && !typed.message.includes('fetch')) {
    return { code: typed.code ?? null, message: typed.message };
  }
  return { code: null, message: '네트워크 또는 서버 상태를 확인한 뒤 다시 시도해 주세요.' };
}

export function formatFundingDate(value: string | null): string {
  if (value === null) return '기록 없음';
  return new Date(`${value}T00:00:00Z`).toLocaleDateString('ko-KR');
}

export function formatFundingWon(value: string): string {
  return `${numberFormat.format(BigInt(value))}원`;
}

// 계획 화면에서만 쓰는 적용 동작. 페이지 단위 조회(/funding)는 계획이 없으므로
// 이 값 없이 같은 결과 표시를 재사용한다.
export type FundingApplyContext = {
  disabled: boolean;
  disabledReason: string;
  applyingKey: string | null;
  appliedKey: string | null;
  // 계획에 저장된 사용자의 시뮬레이션 원금. 공개 한도와 비교하고 상품 조건 적용 시
  // 그대로 유지한다.
  principalKrw: string | null;
  onApply: (evaluation: FundingCandidateEvaluation) => void;
};

// 조건을 입력하지 않아 판정이 UNKNOWN으로만 남는 상태인지. 후보 0건·카탈로그
// 없음과 구분해 화면에서 따로 안내한다.
export function isEmptyFundingProfile(profile: FundingProfile): boolean {
  return (
    profile.businessStage === 'UNKNOWN' &&
    profile.districtCode === null &&
    profile.industryCode === null &&
    profile.purpose === 'UNKNOWN'
  );
}

export function fundingProfileSummary(profile: FundingProfile): string {
  return [
    profile.businessStage === 'UNKNOWN' ? '사업 단계 미입력' : stageLabel(profile.businessStage),
    profile.districtCode === null
      ? '자치구 미입력'
      : `${districtName(profile.districtCode) ?? profile.districtCode}(${profile.districtCode})`,
    profile.industryCode === null ? '업종 미입력' : profile.industryCode,
    profile.purpose === 'UNKNOWN' ? '용도 미입력' : purposeLabel(profile.purpose),
  ].join(' · ');
}

export function FundingCandidatesErrorPanel({ error }: { readonly error: FundingLoadError }) {
  if (error.code === 'CATALOG_UNAVAILABLE') {
    return (
      <div className="empty-panel" role="status">
        <h2>활성 자금 카탈로그가 없습니다.</h2>
        <p>
          운영자가 검수한 카탈로그를 <code>npm --prefix app run funding:load</code>로 활성화하기 전까지는 후보를 조회할
          수 없습니다. 카탈로그가 없는 상태를 후보 0건으로 대신 표시하지 않습니다.
        </p>
      </div>
    );
  }
  if (error.code === 'INVALID_INPUT') {
    return (
      <div className="empty-panel" role="status">
        <h2>저장된 자금 조건을 쓸 수 없습니다.</h2>
        <p>{error.message}</p>
      </div>
    );
  }
  return (
    <div className="error-box" role="alert">
      <h2>후보를 불러오지 못했습니다.</h2>
      <p>{error.message}</p>
    </div>
  );
}

export function FundingCandidatesPanel({
  result,
  profileSummary,
  planLabel,
  apply,
}: {
  readonly result: FundingCandidatesResponse;
  readonly profileSummary: string;
  // 계획 기준 조회면 어느 계획·revision의 조건인지 밝힌다.
  readonly planLabel?: string;
  readonly apply?: FundingApplyContext;
}) {
  const { summary } = result;
  const emptyProfile = isEmptyFundingProfile(result.profile);
  return (
    <>
      <section className="release-card" aria-labelledby="funding-release">
        <h2 id="funding-release">판정 기준</h2>
        {planLabel && <p className="funding-position">{planLabel}</p>}
        <dl className="release-grid">
          <div>
            <dt>카탈로그</dt>
            <dd>
              {result.release.catalogKey}@{result.release.catalogVersion}
            </dd>
          </div>
          <div>
            <dt>기준일</dt>
            <dd>{formatFundingDate(result.release.basisDate)}</dd>
          </div>
          <div>
            <dt>판정 기준일</dt>
            <dd>{formatFundingDate(result.asOfDate)}</dd>
          </div>
          <div>
            <dt>검수일</dt>
            <dd>{formatFundingDate(result.release.reviewedAt)}</dd>
          </div>
          <div>
            <dt>검수자</dt>
            <dd>{result.release.reviewer}</dd>
          </div>
          <div>
            <dt>적재 스키마</dt>
            <dd>{result.release.schemaVersion}</dd>
          </div>
          <div>
            <dt>활성화 시각</dt>
            <dd>
              {result.release.activatedAt ? new Date(result.release.activatedAt).toLocaleString('ko-KR') : '기록 없음'}
            </dd>
          </div>
          <div>
            <dt>상품 수</dt>
            <dd>{numberFormat.format(result.release.productCount)}건</dd>
          </div>
        </dl>
        <p className="picker-note">판정에 쓴 조건: {profileSummary}</p>
      </section>

      <section className="status-counts" aria-label="상태별 개수">
        {GROUPS.map((group) => (
          <div key={group.status} className={`status-count count-${group.status.toLowerCase()}`}>
            <span>{group.title}</span>
            <strong>{numberFormat.format(summary[group.status])}건</strong>
          </div>
        ))}
        <div className="status-count count-total">
          <span>전체 상품</span>
          <strong>{numberFormat.format(summary.total)}건</strong>
        </div>
      </section>

      {summary.total === 0 && (
        <div className="empty-panel" role="status">
          <h2>활성 카탈로그에 상품이 없습니다.</h2>
          <p>검수된 상품이 적재되지 않았습니다. 후보 0건과 카탈로그 없음은 다른 상태입니다.</p>
        </div>
      )}

      {summary.total > 0 && summary.CURRENT_CANDIDATE === 0 && (
        <div className="notice-box" role="status">
          <h2>현재 신청 가능한 후보가 0건입니다.</h2>
          <p>
            후보 0건은 정상 결과입니다. 접수 상태가 접수 중으로 확인된 상품이 없거나, 확인된 조건이 모두 충족되지
            않았거나, 원문 근거가 부족해 추가 확인으로 남은 상태입니다.
            {emptyProfile &&
              ' 입력한 조건이 없어 대부분의 조건이 미확인으로 남았습니다. 사업 단계·자치구·업종·용도를 입력하면 판정이 달라집니다.'}
          </p>
        </div>
      )}

      {GROUPS.map((group) => {
        const items = result.evaluations.filter((evaluation) => evaluation.candidateStatus === group.status);
        return (
          <section key={group.status} className={`candidate-group${group.separated ? ' separated-group' : ''}`}>
            <div className="group-head">
              <h2>{group.title}</h2>
              <span>{numberFormat.format(items.length)}건</span>
            </div>
            <p className="group-note">
              {group.separated && <strong className="separated-tag">현재 후보와 분리</strong>} {group.note}
            </p>
            {items.length === 0 ? (
              <p className="empty-state">해당하는 상품이 없습니다.</p>
            ) : (
              <div className="candidate-list">
                {items.map((evaluation) => (
                  <CandidateCard
                    key={`${evaluation.productKey}@${evaluation.version}`}
                    evaluation={evaluation}
                    apply={apply}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}

function CandidateCard({
  evaluation,
  apply,
}: {
  readonly evaluation: FundingCandidateEvaluation;
  readonly apply?: FundingApplyContext;
}) {
  const { repayment } = evaluation;
  const cardKey = `${evaluation.productKey}@${evaluation.version}`;
  const amountIssue =
    apply && repayment.publicLimitKrw !== null
      ? apply.principalKrw === null || apply.principalKrw === '0'
        ? '재무 입력의 신규 대출금을 1원 이상 입력하고 초안을 저장해 주세요.'
        : BigInt(apply.principalKrw) > BigInt(repayment.publicLimitKrw)
          ? `저장된 신규 대출금이 공개 한도 ${formatFundingWon(repayment.publicLimitKrw)}를 초과합니다.`
          : null
      : null;
  return (
    <article className="candidate-card">
      <div className="candidate-head">
        <div>
          <h3>{evaluation.name}</h3>
          <p className="candidate-org">{evaluation.organization}</p>
        </div>
        <div className="candidate-tags">
          <span className={`support-badge support-${evaluation.supportType.toLowerCase()}`}>
            {SUPPORT_TYPE_LABELS[evaluation.supportType]}
          </span>
          <span className={`candidate-status status-${evaluation.candidateStatus.toLowerCase()}`}>
            {STATUS_LABELS[evaluation.candidateStatus]}
          </span>
        </div>
      </div>

      <p className="candidate-reason">{evaluation.candidateReason}</p>

      <dl className="candidate-meta">
        <div>
          <dt>상품 버전</dt>
          <dd>
            {evaluation.productKey}@{evaluation.version}
          </dd>
        </div>
        <div>
          <dt>접수 상태</dt>
          <dd>
            {APPLICATION_STATUS_LABELS[evaluation.observedApplicationStatus]} ·{' '}
            {formatFundingDate(evaluation.observedAt)} 확인
          </dd>
        </div>
        <div>
          <dt>검수 상태</dt>
          <dd>
            {REVIEW_STATE_LABELS[evaluation.reviewState]} · 검수일 {formatFundingDate(evaluation.reviewedAt)} · 다음
            검토일 {formatFundingDate(evaluation.nextReviewAt)}
          </dd>
        </div>
        <div>
          <dt>자격 판정</dt>
          <dd>{VERDICT_LABELS[evaluation.eligibilityVerdict]}</dd>
        </div>
      </dl>

      <div className="table-scroll">
        <table className="condition-table">
          <caption>조건별 판정과 이유</caption>
          <thead>
            <tr>
              <th scope="col">조건</th>
              <th scope="col">판정</th>
              <th scope="col">이유</th>
              <th scope="col">근거</th>
            </tr>
          </thead>
          <tbody>
            {evaluation.conditions.map((condition) => (
              <tr key={condition.key}>
                <th scope="row">{condition.label}</th>
                <td>
                  <span className={`verdict verdict-${condition.verdict.toLowerCase()}`}>
                    {VERDICT_LABELS[condition.verdict]}
                  </span>
                </td>
                <td className="reason-cell">{condition.detail}</td>
                <td className="reason-cell">
                  {condition.evidenceIds.length === 0 ? '기록 없음' : condition.evidenceIds.join(', ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="candidate-detail">
        <div>
          <h4>신청 전 추가 확인</h4>
          {evaluation.manualChecks.length === 0 ? (
            <p className="empty-state">기록된 추가 확인 항목이 없습니다.</p>
          ) : (
            <ul className="reason-list">
              {evaluation.manualChecks.map((check) => (
                <li key={check}>{check}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4>상환 계산 가능 여부</h4>
          {repayment.supported && repayment.terms ? (
            <>
              <p className="repayment-ok">
                상품 확정 조건으로 상환 부담을 계산할 수 있는 구조입니다. 승인 확정이 아니며 실제 승인·적용 금리는
                심사로 결정됩니다.
              </p>
              <dl className="candidate-meta">
                <div>
                  <dt>공개 한도</dt>
                  <dd>{formatFundingWon(repayment.publicLimitKrw!)}</dd>
                </div>
                <div>
                  <dt>연 금리(확정)</dt>
                  <dd>{repayment.terms.annualInterestRatePercent}%</dd>
                </div>
                <div>
                  <dt>전체 상환개월</dt>
                  <dd>{numberFormat.format(repayment.terms.totalMonths)}개월</dd>
                </div>
                <div>
                  <dt>원금 거치개월</dt>
                  <dd>{numberFormat.format(repayment.terms.graceMonths)}개월</dd>
                </div>
                <div>
                  <dt>상환방식</dt>
                  <dd>{repayment.terms.repaymentMethod === 'EQUAL_INSTALLMENT' ? '원리금균등' : '원금균등'}</dd>
                </div>
              </dl>
            </>
          ) : (
            <p className="repayment-no">
              상환 계산 대상이 아닙니다. 상품 조건 기반 상환액을 0원으로 대신 표시하지 않습니다.
            </p>
          )}
          {repayment.reasons.length > 0 && (
            <ul className="reason-list">
              {repayment.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          )}
          <p className="table-note">{repayment.note}</p>
          {apply && repayment.supported && evaluation.candidateStatus === 'CURRENT_CANDIDATE' && (
            <div className="button-row">
              <button
                type="button"
                disabled={apply.disabled || amountIssue !== null || apply.applyingKey === cardKey}
                onClick={() => apply.onApply(evaluation)}
              >
                {apply.applyingKey === cardKey ? '적용 중…' : '저장된 신규 대출금에 이 상품 조건 적용'}
              </button>
              {apply.disabled && apply.applyingKey !== cardKey && <p className="table-note">{apply.disabledReason}</p>}
              {!apply.disabled && amountIssue && <p className="table-note">{amountIssue}</p>}
              {apply.appliedKey === cardKey && (
                <p className="table-note">현재 저장된 대출 가정이 이 상품 확정 조건입니다.</p>
              )}
            </div>
          )}
        </div>
      </div>

      <p className="source-link">
        <a href={evaluation.officialUrl} target="_blank" rel="noreferrer">
          공식 원문 열기
        </a>
      </p>
    </article>
  );
}
