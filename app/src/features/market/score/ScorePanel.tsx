'use client';

import Link from 'next/link';
import type { MarketScoreResponse, ScoreContribution } from './api.ts';
import { handoffSearch, storeHandoff, type MarketScoreHandoff } from './handoff.ts';

const numberFormat = new Intl.NumberFormat('ko-KR');

export const SCORE_EXPLANATION =
  '이 상권에 있는 같은 업종 점포들의 향후 1년 폐업률이 서울 중간 수준보다 낮을 가능성을 0~100으로 나타낸 값입니다. 개별 점포의 생존 확률이 아닙니다.';

export function formatWon(value: string): string {
  return `${numberFormat.format(BigInt(value))}원`;
}

function formatDisplay(item: Pick<ScoreContribution, 'unit' | 'key'>, value: string): string {
  if (item.unit === 'WON') return formatWon(value);
  if (item.unit === 'COUNT') return `${numberFormat.format(Number(value))}개`;
  const percent = Number(value) * 100;
  const sign = item.key === 'salesGrowth' && percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}%`;
}

const COMPARISON_LABEL = { HIGHER: '높음', LOWER: '낮음', SAME: '같음' } as const;
const EFFECT_LABEL = { RAISES: '올림', LOWERS: '내림' } as const;

export function handoffFor(score: MarketScoreResponse): MarketScoreHandoff {
  return {
    areaType: score.area.areaType,
    areaCode: score.area.areaCode,
    industryCode: score.industry.code,
    releaseKey: score.release.releaseKey,
  };
}

export default function ScorePanel({ score }: { readonly score: MarketScoreResponse }) {
  const handoff = handoffFor(score);
  return (
    <section className="score-panel" aria-labelledby="score-title">
      <div className="score-heading">
        <p className="eyebrow">상권 생존점수 · {score.baseQuarterLabel} 기준</p>
        <h2 id="score-title">
          {score.area.displayName} · {score.industry.displayName}
        </h2>
      </div>

      {score.status === 'OK' && score.score ? (
        <>
          <div className="score-header">
            <div className="score-value" aria-label={`점수 ${score.score.value}점, 등급 ${score.score.grade}`}>
              <strong>{score.score.value}</strong>
              <span>점</span>
              <b className={`grade-badge grade-${score.score.grade.toLowerCase()}`}>{score.score.grade}</b>
            </div>
            <div className="score-rank">
              <strong>
                서울 {score.industry.displayName} 상권 {numberFormat.format(score.score.total)}곳 중 상위{' '}
                {score.score.topPercent}%
              </strong>
              <span>
                전체 {numberFormat.format(score.score.total)}곳 중 {numberFormat.format(score.score.rank)}위 · 기준분기{' '}
                {score.baseQuarterLabel}
              </span>
            </div>
          </div>
          <p className="score-explanation">{SCORE_EXPLANATION}</p>

          <ContributionBars items={score.contributions} />
          {score.distribution && <DistributionChart distribution={score.distribution} value={score.score.value} />}

          <div className="button-row score-actions">
            <Link href={`/${handoffSearch(handoff)}`} onClick={() => storeHandoff(handoff)} className="primary-link">
              이 상권으로 재무 계획 시작
            </Link>
            <Link href={`/funding${handoffSearch(handoff)}`} className="secondary-link">
              자금 후보 보기
            </Link>
          </div>
          {score.financeDefault && (
            <p className="table-note">
              재무 계획에는 월매출 기본값 {formatWon(score.financeDefault.monthlyRevenue)}(잠정, 점포당 월평균)을 채워
              넘기며, 계획 화면에서 고칠 수 있습니다.
            </p>
          )}
          {score.financeDefault?.unusual && <UnusualRevenueWarning score={score} />}
        </>
      ) : (
        <div className="score-unavailable" role="status">
          <strong>{score.message}</strong>
          <p>{SCORE_EXPLANATION}</p>
        </div>
      )}

      <ScoreBasis score={score} />
    </section>
  );
}

export function UnusualRevenueWarning({ score }: { readonly score: MarketScoreResponse }) {
  const finance = score.financeDefault;
  if (!finance?.unusual || !finance.warningRange) return null;
  return (
    <p className="inline-error" role="note">
      이 상권의 점포당 월매출(잠정)은 서울 {score.industry.displayName} 상권{' '}
      {finance.unusual === 'HIGH'
        ? `상위 1% 경계(${formatWon(finance.warningRange.high)})보다 높습니다. 법인·단체 수요 등으로`
        : `하위 1% 경계(${formatWon(finance.warningRange.low)})보다 낮습니다. 추정 자료의 한계 등으로`}{' '}
      개인 점포의 매출과 크게 다를 수 있으니 그대로 쓰지 말고 확인해 주세요.
    </p>
  );
}

function ContributionBars({ items }: { readonly items: readonly ScoreContribution[] }) {
  const max = Math.max(...items.map((item) => Math.abs(item.contribution)), 1e-9);
  return (
    <div className="score-factors">
      <h3>점수에 영향을 준 요인</h3>
      <ul>
        {items.map((item) => {
          const width = (Math.abs(item.contribution) / max) * 50;
          return (
            <li key={item.key}>
              <p>
                <strong>
                  {item.label}: 업종 평균보다 {COMPARISON_LABEL[item.comparison]} → 점수 {EFFECT_LABEL[item.effect]}
                </strong>
                <span>
                  {item.displayLabel}: 이 상권 {formatDisplay(item, item.value)} · 업종 평균{' '}
                  {formatDisplay(item, item.average)}
                </span>
              </p>
              <div className="factor-track" aria-hidden="true">
                <span
                  className={item.effect === 'RAISES' ? 'factor-bar raises' : 'factor-bar lowers'}
                  style={
                    item.effect === 'RAISES'
                      ? { left: '50%', width: `${width}%` }
                      : { right: '50%', width: `${width}%` }
                  }
                />
              </div>
            </li>
          );
        })}
      </ul>
      <p className="table-note">
        막대는 가운데(0)를 기준으로 오른쪽이 점수를 올린 요인, 왼쪽이 내린 요인입니다. 높음·낮음은 실제 값으로,
        올림·내림은 모델 기여도 부호로 정합니다.
      </p>
    </div>
  );
}

function DistributionChart({
  distribution,
  value,
}: {
  readonly distribution: NonNullable<MarketScoreResponse['distribution']>;
  readonly value: number;
}) {
  const max = Math.max(...distribution.bins.map((bin) => bin.count), 1);
  const current = Math.min(9, Math.floor(value / 10));
  return (
    <div className="score-distribution">
      <h3>같은 업종 상권 점수 분포</h3>
      <div
        className="histogram"
        role="img"
        aria-label={`서울 상권 ${distribution.total}곳의 10점 구간 분포. 이 상권은 ${distribution.bins[current].from}~${distribution.bins[current].to}점 구간입니다.`}
      >
        {distribution.bins.map((bin, index) => (
          <div key={bin.from} className={index === current ? 'histogram-bin current' : 'histogram-bin'}>
            {index === current && <em>이 상권 {value}점</em>}
            <span style={{ height: `${Math.max(2, (bin.count / max) * 100)}%` }} />
            <small>{bin.from}</small>
            <b>{numberFormat.format(bin.count)}</b>
          </div>
        ))}
      </div>
    </div>
  );
}

function ScoreBasis({ score }: { readonly score: MarketScoreResponse }) {
  return (
    <details className="score-basis">
      <summary>산출 근거</summary>
      {score.model ? (
        <>
          <dl className="release-grid">
            <div>
              <dt>모델</dt>
              <dd>로지스틱 회귀 · {score.model.version}</dd>
            </div>
            <div>
              <dt>학습 기간</dt>
              <dd>{score.model.trainPeriod}</dd>
            </div>
            <div>
              <dt>테스트 기간</dt>
              <dd>{score.model.testPeriod}</dd>
            </div>
            <div>
              <dt>표본 수</dt>
              <dd>
                학습 {numberFormat.format(score.model.trainSize)} · 테스트 {numberFormat.format(score.model.testSize)}
              </dd>
            </div>
            <div>
              <dt>테스트 AUC</dt>
              <dd>{score.model.testAuc.toFixed(3)}</dd>
            </div>
            <div>
              <dt>점수 릴리스</dt>
              <dd>{score.release.releaseKey}</dd>
            </div>
          </dl>
          <div className="table-scroll">
            <table className="market-table">
              <caption>계수표 (고폐업 확률 기준, 표준화. 점수 기여도는 −β × z)</caption>
              <thead>
                <tr>
                  <th scope="col">변수</th>
                  <th scope="col">정의</th>
                  <th scope="col">β</th>
                  <th scope="col">표준오차</th>
                  <th scope="col">p값</th>
                </tr>
              </thead>
              <tbody>
                {score.model.coefficients.map((item) => (
                  <tr key={item.key}>
                    <th scope="row">{item.label}</th>
                    <td className="note-cell">{item.definition}</td>
                    <td>{item.beta.toFixed(3)}</td>
                    <td>{item.standardError.toFixed(3)}</td>
                    <td>{item.pValue < 0.001 ? '<0.001' : item.pValue.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="table-note">
            점수 = round((1 − 고폐업 확률) × 100). 등급:{' '}
            {score.model.gradeBoundaries.map((item) => `${item.grade} ${item.minScore}점 이상`).join(', ')}.
          </p>
        </>
      ) : (
        <p className="table-note">이 업종은 점수 모델을 제공하지 않습니다.</p>
      )}
      <h3>한계</h3>
      <ul>
        {score.limitations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="table-note">상권 릴리스 {score.release.marketReleaseKey}</p>
    </details>
  );
}
