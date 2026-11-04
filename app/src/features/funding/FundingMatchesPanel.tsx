'use client';

import { useState } from 'react';
import { CONDITION_MODEL, CONDITION_PROMPT_VERSION } from './condition-fields.ts';
import type { FundingMatchesWithProfile } from './match-list.ts';
import type { DistrictSource } from './match-profile.ts';
import {
  AI_READING_NOTICE,
  CONDITION_LABELS,
  FUNDING_GROUP_LABELS,
  FUNDING_TAB_LABELS,
  LIMIT_NOTE,
  MATCH_VERDICT_LABELS,
  SUPPORT_TYPE_LABELS,
  aiPeriodText,
  applicationPeriodText,
  checkReasonText,
  closedText,
  conditionValueText,
  formatDate,
  fundingGapText,
  fundingProfileSummary,
  holdText,
  limitText,
  supportTypesText,
  type ViewedFundingGap,
} from './match-text.ts';
import { FUNDING_TABS, type ConditionMatch, type FundingTab, type ProductMatch } from './matching.ts';
import type { ObservedApplicationStatus } from './types.ts';

// 맞춰 보기 결과(ADR 0009 §4). /funding과 계획 화면이 같은 결과를 같은 모양으로 보여 준다. 정책자금·지원사업 탭마다
// 맞아 보임 → 확인 필요 → 안 맞아 보임(접어 둠) → 마감(기본으로 숨김) 순서다. AI가 읽은 값으로는 공고를 숨기지 않는다.

const numberFormat = new Intl.NumberFormat('ko-KR');

const TAB_NOTES: Record<FundingTab, string> = {
  POLICY_FUND:
    '소진공 정책자금, 기업마당의 금융 분야 공고, 운영자가 등록한 대출·보증입니다. 상품 조건은 재무 계획에 옮기지 않으니 대출 조건은 재무 계획에 직접 입력해 주세요.',
  SUPPORT_PROGRAM:
    '기업마당의 나머지 공고와 운영자가 등록한 지원금·공간·프로그램입니다. 조달액이나 대출 상환으로 계산하지 않습니다.',
};

const APPLICATION_STATUS_LABELS: Record<ObservedApplicationStatus, string> = {
  OPEN: '접수 중으로 확인',
  CLOSED: '접수 마감으로 확인',
  UNKNOWN: '접수 상태 미확인',
};

export type FundingLoadError = { code: string | null; message: string };

// 응답이 우리 API에서 온 것이면 한국어 메시지가 있고, 네트워크 실패면 없다.
// 브라우저의 'Failed to fetch' 대신 확인할 수 있는 문장을 보여 준다.
export function describeFundingError(error: unknown): FundingLoadError {
  const typed = error as Error & { code?: string };
  if (typed && typeof typed.message === 'string' && typed.message.length > 0 && !typed.message.includes('fetch')) {
    return { code: typed.code ?? null, message: typed.message };
  }
  return { code: null, message: '네트워크 또는 서버 상태를 확인한 뒤 다시 시도해 주세요.' };
}

export function FundingMatchesErrorPanel({ error }: { readonly error: FundingLoadError }) {
  if (error.code === 'CATALOG_UNAVAILABLE') {
    return (
      <div className="empty-panel" role="status">
        <h2>활성 자금 카탈로그가 없습니다.</h2>
        <p>
          운영자가 <code>npm --prefix app run funding:sync</code> 또는 <code>funding:load</code>로 카탈로그를 적재하기
          전까지는 공고를 맞춰 볼 수 없습니다. 카탈로그가 없는 상태를 0건으로 대신 보여 주지 않습니다.
        </p>
      </div>
    );
  }
  if (error.code === 'INVALID_INPUT') {
    return (
      <div className="empty-panel" role="status">
        <h2>자금 조건을 쓸 수 없습니다.</h2>
        <p>{error.message}</p>
      </div>
    );
  }
  return (
    <div className="error-box" role="alert">
      <h2>공고를 맞춰 보지 못했습니다.</h2>
      <p>{error.message}</p>
    </div>
  );
}

export function FundingMatchesPanel({
  result,
  districtSource = null,
  planLabel,
  fundingGap,
}: {
  readonly result: FundingMatchesWithProfile;
  readonly districtSource?: DistrictSource;
  // 계획 기준 조회면 어느 계획·revision의 조건인지 밝힌다.
  readonly planLabel?: string;
  // 계획 화면에서 보고 있는 저장 결과의 부족자금. undefined면 계획이 없는 화면(/funding)이라 보여 주지 않는다.
  readonly fundingGap?: ViewedFundingGap;
}) {
  const [tab, setTab] = useState<FundingTab>('POLICY_FUND');
  const shown = FUNDING_TABS.reduce((sum, key) => sum + result.tabs[key].products.length, 0);
  const noInput = Object.values(result.profile).every((value) => value === null);
  return (
    <>
      <section className="release-card" aria-labelledby="funding-release">
        <h2 id="funding-release">맞춰 본 기준</h2>
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
            <dd>{formatDate(result.release.basisDate)}</dd>
          </div>
          <div>
            <dt>판정 기준일</dt>
            <dd>{formatDate(result.asOfDate)}</dd>
          </div>
          <div>
            <dt>활성화 시각</dt>
            <dd>
              {result.release.activatedAt ? new Date(result.release.activatedAt).toLocaleString('ko-KR') : '기록 없음'}
            </dd>
          </div>
          <div>
            <dt>공고 수</dt>
            <dd>
              {numberFormat.format(result.release.productCount)}건
              {result.hiddenCount > 0 &&
                ` (그중 운영자가 숨긴 ${numberFormat.format(result.hiddenCount)}건은 보여 주지 않음)`}
            </dd>
          </div>
          <div>
            <dt>조건 읽기</dt>
            <dd>
              {CONDITION_MODEL} · {CONDITION_PROMPT_VERSION}
            </dd>
          </div>
        </dl>
        <p className="picker-note">맞춰 본 조건: {fundingProfileSummary(result.profile, districtSource)}</p>
      </section>

      {shown === 0 ? (
        <div className="empty-panel" role="status">
          <h2>보여 줄 공고가 없습니다.</h2>
          <p>
            {result.hiddenCount > 0
              ? '활성 카탈로그의 공고를 운영자가 모두 숨겼습니다.'
              : '활성 카탈로그에 적재된 공고가 없습니다.'}{' '}
            공고 0건과 카탈로그 없음은 다른 상태입니다.
          </p>
        </div>
      ) : (
        <>
          {noInput && (
            <div className="notice-box" role="status">
              <h2>입력한 조건이 없습니다.</h2>
              <p>
                조건을 정한 공고(예: 나이·자치구 한정)는 대부분 확인 필요로 남습니다. 사업자등록 여부·자치구·나이·대상
                한정을 입력하면 더 많이 맞춰 볼 수 있습니다.
              </p>
            </div>
          )}
          <div className="funding-tabs" role="tablist" aria-label="자금 갈래">
            {FUNDING_TABS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`funding-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`funding-tabpanel-${key}`}
                className={`funding-tab${tab === key ? ' active' : ''}`}
                onClick={() => setTab(key)}
              >
                <span>{FUNDING_TAB_LABELS[key]}</span>
                <small>
                  {FUNDING_GROUP_LABELS.MATCHING} {numberFormat.format(result.tabs[key].counts.MATCHING)} ·{' '}
                  {FUNDING_GROUP_LABELS.NEEDS_CHECK} {numberFormat.format(result.tabs[key].counts.NEEDS_CHECK)}
                </small>
              </button>
            ))}
          </div>
          <TabPanel key={tab} tab={tab} list={result.tabs[tab]} fundingGap={fundingGap} />
        </>
      )}
    </>
  );
}

function TabPanel({
  tab,
  list,
  fundingGap,
}: {
  readonly tab: FundingTab;
  readonly list: FundingMatchesWithProfile['tabs'][FundingTab];
  readonly fundingGap: ViewedFundingGap | undefined;
}) {
  const [showClosed, setShowClosed] = useState(false);
  const of = (group: ProductMatch['group']) => list.products.filter((entry) => entry.group === group);
  const [matching, needsCheck, notMatching, closed] = [
    of('MATCHING'),
    of('NEEDS_CHECK'),
    of('NOT_MATCHING'),
    of('CLOSED'),
  ];
  const policy = tab === 'POLICY_FUND';
  const cards = (items: ProductMatch[]) => (
    <div className="candidate-list">
      {items.map((entry) => (
        <MatchCard key={`${entry.productKey}@${entry.version}`} match={entry} policy={policy} fundingGap={fundingGap} />
      ))}
    </div>
  );
  return (
    <section
      id={`funding-tabpanel-${tab}`}
      role="tabpanel"
      aria-labelledby={`funding-tab-${tab}`}
      className="funding-branch"
    >
      <p className="branch-note">{TAB_NOTES[tab]}</p>
      {policy && (
        <div className="match-limit-note" role="note">
          <p>{LIMIT_NOTE}</p>
          {fundingGap !== undefined && <p>{fundingGapText(fundingGap)}</p>}
        </div>
      )}
      <div className="status-counts branch-counts" aria-label={`${FUNDING_TAB_LABELS[tab]} 그룹별 개수`}>
        {(['MATCHING', 'NEEDS_CHECK', 'NOT_MATCHING', 'CLOSED'] as const).map((group) => (
          <div key={group} className={`status-count count-${group.toLowerCase()}`}>
            <span>{FUNDING_GROUP_LABELS[group]}</span>
            <strong>{numberFormat.format(list.counts[group])}건</strong>
          </div>
        ))}
      </div>

      {list.products.length === 0 ? (
        <p className="empty-state">이 갈래에 보여 줄 공고가 없습니다.</p>
      ) : (
        <>
          <div className="candidate-group">
            <div className="group-head">
              <h3>맞아 보이는 공고</h3>
              <span>{numberFormat.format(matching.length)}건</span>
            </div>
            <p className="group-note">
              여섯 항목이 모두 맞아 보이고 출처에서 접수 중으로 확인한 공고입니다. 선정이나 지원 결정을 뜻하지 않습니다.
            </p>
            {matching.length === 0 ? (
              <p className="empty-state">
                맞아 보이는 공고가 0건입니다. 정상 결과입니다. 확인 필요 공고에 남은 항목을 원 공고에서 확인해 주세요.
              </p>
            ) : (
              cards(matching)
            )}
          </div>

          {needsCheck.length > 0 && (
            <div className="candidate-group">
              <div className="group-head">
                <h3>확인이 필요한 공고</h3>
                <span>{numberFormat.format(needsCheck.length)}건</span>
              </div>
              <p className="group-note">
                안 맞아 보이는 항목은 없지만, 공고문에 없거나 AI가 읽지 못했거나 입력이 없는 항목, 또는 접수 상태 확인이
                남은 공고입니다.
              </p>
              {cards(needsCheck)}
            </div>
          )}

          {notMatching.length > 0 && (
            <details className="candidate-group separated-group match-folded">
              <summary className="group-head">
                <h3>조건이 안 맞아 보이는 공고</h3>
                <span>{numberFormat.format(notMatching.length)}건 · 펼치기</span>
              </summary>
              <p className="group-note">
                AI가 읽은 조건 중 안 맞아 보이는 항목이 있습니다. AI가 잘못 읽었을 수 있어 숨기지 않고 접어 둡니다.
              </p>
              {cards(notMatching)}
            </details>
          )}

          {closed.length > 0 && (
            <div className="candidate-group separated-group">
              <div className="group-head">
                <h3>마감</h3>
                <button type="button" className="link-button" onClick={() => setShowClosed((current) => !current)}>
                  {showClosed ? '마감된 공고 숨기기' : `마감된 공고 ${numberFormat.format(closed.length)}건 보기`}
                </button>
              </div>
              <p className="group-note">출처나 운영자 기록으로 접수가 끝난 공고입니다.</p>
              {showClosed && cards(closed)}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function MatchCard({
  match,
  policy,
  fundingGap,
}: {
  readonly match: ProductMatch;
  readonly policy: boolean;
  readonly fundingGap: ViewedFundingGap | undefined;
}) {
  const closed = closedText(match);
  const { aiPeriod } = match.application;
  return (
    <article className="candidate-card">
      <div className="candidate-head">
        <div>
          <h4>{match.name}</h4>
          <p className="candidate-org">{match.organization}</p>
        </div>
        <div className="candidate-tags">
          <span className={`candidate-status status-${match.group.toLowerCase()}`}>
            {FUNDING_GROUP_LABELS[match.group]}
          </span>
          {match.supportType !== 'UNKNOWN' && (
            <span className={`support-badge support-${match.supportType.toLowerCase()}`}>
              {SUPPORT_TYPE_LABELS[match.supportType]}
            </span>
          )}
          {match.automation && <span className="auto-badge">자동 수집</span>}
        </div>
      </div>

      {(closed !== null || match.holds.length > 0) && (
        <ul className="reason-list match-holds">
          {closed !== null && <li>{closed}</li>}
          {match.holds.map((hold) => (
            <li key={hold}>{holdText(hold, match)}</li>
          ))}
        </ul>
      )}

      <dl className="candidate-meta">
        <div>
          <dt>접수(출처 기록)</dt>
          <dd>
            {APPLICATION_STATUS_LABELS[match.application.status]} · {applicationPeriodText(match.application.period)}
          </dd>
        </div>
        <div>
          <dt>확인 방식</dt>
          <dd>
            {match.automation
              ? `자동 수집 · 출처 ${match.automation.sourceLabel} · 마지막 확인 ${formatDate(match.automation.lastSucceededOn)}`
              : match.operatorRecord
                ? `운영자 등록 · 기록일 ${formatDate(match.operatorRecord.observedAt)}`
                : '운영자 등록'}
          </dd>
        </div>
        {aiPeriod.status === 'READ' && (
          <div>
            <dt>AI가 읽은 신청기간</dt>
            <dd>
              {aiPeriodText(aiPeriod.value)}
              {aiPeriod.source === 'AI' && <q className="match-quote">{aiPeriod.quote}</q>}
            </dd>
          </div>
        )}
        {match.supportTypes.status === 'READ' && (
          <div>
            <dt>AI가 읽은 지원 방식</dt>
            <dd>
              {supportTypesText(match.supportTypes.value)}
              {match.supportTypes.source === 'AI' && <q className="match-quote">{match.supportTypes.quote}</q>}
            </dd>
          </div>
        )}
      </dl>

      <ul className="match-conditions" aria-label="조건별 맞춰 보기">
        {match.conditions.map((condition) => (
          <ConditionItem key={condition.key} condition={condition} regionNote={match.operatorRegionNote} />
        ))}
      </ul>

      {policy && (
        <div className="match-limit">
          <p>
            <strong>{limitText(match.limit)}</strong>
          </p>
          <p>{LIMIT_NOTE}</p>
          {fundingGap !== undefined && <p>{fundingGapText(fundingGap)}</p>}
        </div>
      )}

      <p className="match-ai-notice">{AI_READING_NOTICE}</p>
      <p className="source-link">
        <a href={match.officialUrl} target="_blank" rel="noreferrer">
          원 공고 열기
        </a>
        <span className="match-version">
          {match.productKey}@{match.version}
        </span>
      </p>
    </article>
  );
}

function ConditionItem({
  condition,
  regionNote,
}: {
  readonly condition: ConditionMatch;
  readonly regionNote: string | null;
}) {
  const value = conditionValueText(condition);
  const reason = checkReasonText(condition);
  const { reading } = condition;
  return (
    <li className={`match-condition condition-${condition.verdict.toLowerCase()}`}>
      <div className="match-condition-head">
        <strong>{CONDITION_LABELS[condition.key]}</strong>
        <span className={`verdict verdict-${condition.verdict.toLowerCase()}`}>
          {MATCH_VERDICT_LABELS[condition.verdict]}
        </span>
      </div>
      {value !== null && <p className="match-condition-value">{value}</p>}
      {reading.status === 'READ' && reading.source === 'AI' && <q className="match-quote">{reading.quote}</q>}
      {reading.status === 'READ' && reading.source === 'OPERATOR' && (
        <p className="match-evidence">운영자 확인 근거: {reading.evidence.join(' / ')}</p>
      )}
      {condition.key === 'region' && regionNote !== null && (
        <p className="match-evidence">운영자 지역 메모: {regionNote}</p>
      )}
      {reason !== null && <p className="match-reason">{reason}</p>}
    </li>
  );
}
