'use client';

import Decimal from 'decimal.js';
import { formatKoreanWon } from '@/lib/format-won';
import type { FundingCandidatesResponse } from './candidates.ts';
import type { FundingCandidateEvaluation, FundingCandidateStatus } from './eligibility.ts';
import {
  APPLICATION_STATUS_LABELS,
  ConditionTable,
  REVIEW_STATE_LABELS,
  STATUS_LABELS,
  SUPPORT_TYPE_LABELS,
  formatFundingDate,
  isEmptyFundingProfile,
} from './FundingCandidatesPanel.tsx';

// /funding의 보고서 표시. 판정은 서버 결과를 그대로 쓰고, 여기서는 상태별로 묶어
// 읽기 쉽게 배치만 한다. 계획 화면은 같은 판정을 FundingCandidatesPanel로 보여 준다.

const numberFormat = new Intl.NumberFormat('ko-KR');

const REVIEWABLE: readonly FundingCandidateStatus[] = ['CURRENT_CANDIDATE', 'NEEDS_CONFIRMATION'];
const EXCLUDED: readonly FundingCandidateStatus[] = ['POST_REGISTRATION', 'NOT_ELIGIBLE', 'CLOSED', 'REVIEW_OVERDUE'];

// 대출·보증만 금리와 상환 조건이 의미가 있다. 나머지는 금리 칸을 비워 두지 않고 대출이
// 아니라고 쓴다.
const LENDING_TYPES = new Set(['LOAN', 'GUARANTEE']);

function lowestConfirmedRate(evaluations: readonly FundingCandidateEvaluation[]) {
  let best: { rate: string; name: string } | null = null;
  for (const evaluation of evaluations) {
    if (evaluation.candidateStatus !== 'CURRENT_CANDIDATE' || !evaluation.repayment.terms) continue;
    const rate = evaluation.repayment.terms.annualInterestRatePercent;
    if (best === null || new Decimal(rate).lessThan(best.rate)) best = { rate, name: evaluation.name };
  }
  return best;
}

function periodText(period: FundingCandidateEvaluation['announcement']['applicationPeriod']): string {
  if (period.start === null && period.end === null) return '기간 기록 없음';
  return `${period.start ? formatFundingDate(period.start) : '시작일 기록 없음'} ~ ${
    period.end ? formatFundingDate(period.end) : '종료일 기록 없음'
  }`;
}

export default function FundingReport({
  result,
  industryLabel,
  profileSummary,
}: {
  readonly result: FundingCandidatesResponse;
  readonly industryLabel: string | null;
  readonly profileSummary: string;
}) {
  const { summary } = result;
  const reviewable = REVIEWABLE.flatMap((status) =>
    result.evaluations.filter((evaluation) => evaluation.candidateStatus === status),
  );
  const excluded = EXCLUDED.flatMap((status) =>
    result.evaluations.filter((evaluation) => evaluation.candidateStatus === status),
  );
  const lowest = lowestConfirmedRate(result.evaluations);
  const emptyProfile = isEmptyFundingProfile(result.profile);

  if (summary.total === 0) {
    return (
      <div className="empty-panel" role="status">
        <h2>활성 카탈로그에 상품이 없습니다.</h2>
        <p>카탈로그에 적재된 상품이 없습니다. 후보 0건과 카탈로그 없음은 다른 상태입니다.</p>
      </div>
    );
  }

  return (
    <>
      <section className="report-stats" aria-label="판정 요약">
        <div className="report-stat primary">
          <span>현재 검토 후보</span>
          <strong>{numberFormat.format(summary.CURRENT_CANDIDATE)}개</strong>
          <small>확인된 조건을 충족하고 접수 중으로 확인된 자금이에요. 승인 확정이 아니에요.</small>
        </div>
        <div className="report-stat">
          <span>조건 확인이 필요한 자금</span>
          <strong>{numberFormat.format(summary.NEEDS_CONFIRMATION)}개</strong>
          <small>미확인 조건, 원문 근거 부족, 검수 미완료 중 하나가 있어요.</small>
        </div>
        <div className="report-stat">
          <span>검토 후보 중 가장 낮은 확정 금리</span>
          {lowest ? (
            <>
              <strong className="accent">연 {lowest.rate}%</strong>
              <small>{lowest.name}</small>
            </>
          ) : (
            <>
              <strong className="muted">확정 금리 없음</strong>
              <small>금리가 확정 숫자로 기록된 검토 후보가 없어요. 금리 범위·변동금리 문장은 비교하지 않아요.</small>
            </>
          )}
        </div>
        <div className="report-stat">
          <span>제외·분리한 자금</span>
          <strong>{numberFormat.format(excluded.length)}개</strong>
          <small>
            <a href="#funding-excluded">제외 이유 보기</a>
          </small>
        </div>
      </section>

      <section className="report-section plain" aria-labelledby="funding-reviewable">
        <p className="report-kicker">01 · 검토할 정책자금</p>
        <h2 id="funding-reviewable">
          {industryLabel ? `${industryLabel} 창업에 검토할 수 있는 정책자금` : '검토할 수 있는 정책자금'}
        </h2>
        <p className="report-section-desc">
          검토 후보를 먼저, 조건 확인이 필요한 자금을 다음에 정리했어요. 한도·금리·기간은 카탈로그에 기록한 공고
          요약이에요.
        </p>
        {summary.CURRENT_CANDIDATE === 0 && (
          <div className="notice-box" role="status">
            <h2>현재 신청 가능한 후보가 0건입니다.</h2>
            <p>
              후보 0건은 정상 결과입니다. 접수 중으로 확인된 상품이 없거나, 확인된 조건이 모두 충족되지 않았거나, 원문
              근거·검수가 부족해 추가 확인으로 남은 상태입니다.
              {emptyProfile &&
                ' 입력한 조건이 없어 대부분의 조건이 미확인으로 남았습니다. 사업 단계·자치구·업종·용도를 입력하면 판정이 달라집니다.'}
            </p>
          </div>
        )}
        {reviewable.length === 0 ? (
          <p className="empty-state">이번 조건에서 검토하거나 확인할 자금이 없어요.</p>
        ) : (
          <div className="fund-list">
            {reviewable.map((evaluation, index) => (
              <FundCard
                key={`${evaluation.productKey}@${evaluation.version}`}
                evaluation={evaluation}
                order={index + 1}
              />
            ))}
          </div>
        )}
      </section>

      <section className="report-section plain" aria-labelledby="funding-excluded">
        <p className="report-kicker">02 · 해당되지 않는 자금</p>
        <h2 id="funding-excluded">이번 조건에서는 제외했어요</h2>
        {excluded.length === 0 ? (
          <p className="empty-state">제외하거나 분리한 자금이 없어요.</p>
        ) : (
          <ul className="excluded-list">
            {excluded.map((evaluation) => (
              <li key={`${evaluation.productKey}@${evaluation.version}`}>
                <div>
                  <strong>{evaluation.name}</strong>
                  <span>{evaluation.organization}</span>
                </div>
                <div>
                  <span className={`fund-badge status-${evaluation.candidateStatus.toLowerCase()}`}>
                    {STATUS_LABELS[evaluation.candidateStatus]}
                  </span>
                  <p>{evaluation.candidateReason}</p>
                  <a href={evaluation.officialUrl} target="_blank" rel="noreferrer">
                    공식 원문 열기
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="release-card" aria-labelledby="funding-release">
        <h2 id="funding-release">판정 기준</h2>
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
    </>
  );
}

function FundCard({ evaluation, order }: { readonly evaluation: FundingCandidateEvaluation; readonly order: number }) {
  const { announcement, repayment } = evaluation;
  const current = evaluation.candidateStatus === 'CURRENT_CANDIDATE';
  const lending = LENDING_TYPES.has(evaluation.supportType);
  const unknownConditions = evaluation.conditions.filter((condition) => condition.verdict === 'UNKNOWN');
  return (
    <article className="fund-card">
      <div className="fund-main">
        <p className="fund-kicker">
          <span className={`fund-badge status-${evaluation.candidateStatus.toLowerCase()}`}>
            {current ? '검토 후보' : '조건 확인'}
          </span>
          {evaluation.organization} · {SUPPORT_TYPE_LABELS[evaluation.supportType]}
        </p>
        <h3>
          {order}. {evaluation.name}
        </h3>

        <div className={`fund-reason${current ? '' : ' confirm'}`}>
          <strong>{current ? '검토 이유' : '확인할 조건'}</strong>
          <p>{evaluation.candidateReason}</p>
          {!current && unknownConditions.length > 0 && (
            <ul>
              {unknownConditions.map((condition) => (
                <li key={condition.key}>
                  {condition.label}: {condition.detail}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="fund-columns">
          <div>
            <h4>신청처</h4>
            <p>{evaluation.organization}</p>
            <a href={evaluation.officialUrl} target="_blank" rel="noreferrer">
              공식 원문 열기
            </a>
          </div>
          <div>
            <h4>신청 전 확인·유의사항</h4>
            {evaluation.manualChecks.length === 0 ? (
              <p>기록된 추가 확인 항목이 없어요.</p>
            ) : (
              <ul>
                {evaluation.manualChecks.map((check) => (
                  <li key={check}>{check}</li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <details className="report-details">
          <summary>판정 근거 자세히</summary>
          <dl className="candidate-meta">
            <div>
              <dt>상품 버전</dt>
              <dd>
                {evaluation.productKey}@{evaluation.version}
              </dd>
            </div>
            <div>
              <dt>검수 상태</dt>
              <dd>
                {REVIEW_STATE_LABELS[evaluation.reviewState]} · 검수일 {formatFundingDate(evaluation.reviewedAt)} · 다음
                검토일 {formatFundingDate(evaluation.nextReviewAt)}
              </dd>
            </div>
          </dl>
          <ConditionTable evaluation={evaluation} />
          <p className="table-note">
            {repayment.supported ? repayment.note : `상환 계산 대상이 아니에요. ${repayment.reasons.join(' ')}`}
          </p>
        </details>
      </div>

      <dl className="fund-terms">
        <div>
          <dt>공개 한도</dt>
          <dd>
            {announcement.publicLimitKrw === null
              ? '공고에서 확인하지 못했어요'
              : `최대 ${formatKoreanWon(announcement.publicLimitKrw)}`}
          </dd>
        </div>
        <div>
          <dt>금리</dt>
          <dd>
            {repayment.terms
              ? `연 ${repayment.terms.annualInterestRatePercent}% (확정)`
              : !lending
                ? '해당 없음 · 대출이 아니에요'
                : (announcement.interestCondition ?? '공고에서 확정하지 못했어요')}
          </dd>
          {lending && !repayment.terms && <small>확정 숫자가 아니어서 상환 계산에 쓰지 않아요.</small>}
        </div>
        <div>
          <dt>상환 조건</dt>
          <dd>
            {!lending
              ? '해당 없음 · 상환하지 않아요'
              : (announcement.repaymentCondition ?? '공고에서 확정하지 못했어요')}
          </dd>
        </div>
        <div>
          <dt>접수</dt>
          <dd>{APPLICATION_STATUS_LABELS[evaluation.observedApplicationStatus]}</dd>
          <small>
            {periodText(announcement.applicationPeriod)} · {formatFundingDate(evaluation.observedAt)} 확인
            {announcement.applicationPeriod.note ? ` · ${announcement.applicationPeriod.note}` : ''}
          </small>
        </div>
      </dl>
    </article>
  );
}
