'use client';

import { useState } from 'react';
import type { FundingMatchesWithProfile } from './match-list.ts';
import type { DistrictSource } from './match-profile.ts';
import {
  AI_READING_NOTICE,
  CONDITION_LABELS,
  FUNDING_GROUP_BADGE_LABELS,
  FUNDING_TAB_LABELS,
  LIMIT_NOTE,
  UNREAD_NOTICE,
  MATCH_VERDICT_LABELS,
  SUPPORT_TYPE_LABELS,
  aiPeriodText,
  aiPeriodValueText,
  applicationStateText,
  checkReasonText,
  closedText,
  conditionSections,
  conditionValueText,
  formatDate,
  fundingGapText,
  fundingProfileSummary,
  hasAiReading,
  limitText,
  sourceRecordText,
  supportTypesText,
  titleRegionText,
  tabRemainingText,
  unconfirmedReasonText,
  type ViewedFundingGap,
} from './match-text.ts';
import {
  FUNDING_TABS,
  REMAINING_GROUPS,
  applicationState,
  type ConditionMatch,
  type FundingTab,
  type ProductMatch,
} from './matching.ts';

// 맞춰 보기 결과(ADR 0009 §4). /funding과 계획 화면이 같은 결과를 같은 모양으로 보여 준다. 정책자금·지원사업 탭마다 조건에 안
// 맞는 공고를 빼고 남은 공고를 한 목록으로 보여 주고, 뺀 공고와 마감 공고는 건수와 함께 두어 버튼으로 펼친다. 접수 상태는
// 카드마다 따로 보여 준다.

const numberFormat = new Intl.NumberFormat('ko-KR');

const TAB_NOTES: Record<FundingTab, string> = {
  POLICY_FUND:
    '소진공 정책자금, 기업마당 금융 공고, 운영자가 등록한 대출·보증입니다. 대출 조건은 재무 계획에 직접 입력하세요.',
  SUPPORT_PROGRAM:
    '기업마당의 나머지 공고와 운영자가 등록한 지원금·공간·프로그램입니다. 대출 상환으로 계산하지 않습니다.',
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
        <h2>자금 공고 자료가 아직 없습니다.</h2>
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
      <h2>공고를 불러오지 못했습니다.</h2>
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
      <section className="panel funding-basis" aria-labelledby="funding-release">
        <h2 id="funding-release">조회 기준</h2>
        {planLabel && <p className="funding-position">{planLabel}</p>}
        <dl className="release-grid">
          <div>
            <dt>자료 기준일</dt>
            <dd>{formatDate(result.release.basisDate)}</dd>
          </div>
          <div>
            <dt>판정 기준일</dt>
            <dd>{formatDate(result.asOfDate)}</dd>
          </div>
          <div>
            <dt>공고 수</dt>
            <dd>
              {numberFormat.format(result.release.productCount)}건
              {result.hiddenCount > 0 && ` (운영자가 숨긴 ${numberFormat.format(result.hiddenCount)}건 제외)`}
            </dd>
          </div>
        </dl>
        <p className="note">조회 조건: {fundingProfileSummary(result.profile, districtSource)}</p>
      </section>

      {shown === 0 ? (
        <div className="empty-panel" role="status">
          <h2>보여 줄 공고가 없습니다.</h2>
          <p>{result.hiddenCount > 0 ? '운영자가 모든 공고를 숨겼습니다.' : '등록된 공고가 없습니다.'}</p>
        </div>
      ) : (
        <>
          {noInput && (
            <div className="notice-box" role="status">
              <h2>입력한 조건이 없습니다.</h2>
              <p>음식점·카페 제외처럼 입력 없이 정해지는 조건으로만 공고를 뺐습니다.</p>
            </div>
          )}
          <div className="funding-tabs" role="tablist" aria-label="자금 종류">
            {FUNDING_TABS.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`funding-tab-${key}`}
                aria-selected={tab === key}
                aria-controls={`funding-tabpanel-${key}`}
                className="funding-tab"
                onClick={() => setTab(key)}
              >
                <span>{FUNDING_TAB_LABELS[key]}</span>
                <small>{tabRemainingText(result.tabs[key].counts)}</small>
              </button>
            ))}
          </div>
          <TabPanel key={tab} tab={tab} list={result.tabs[tab]} asOfDate={result.asOfDate} fundingGap={fundingGap} />
        </>
      )}
    </>
  );
}

function TabPanel({
  tab,
  list,
  asOfDate,
  fundingGap,
}: {
  readonly tab: FundingTab;
  readonly list: FundingMatchesWithProfile['tabs'][FundingTab];
  readonly asOfDate: string;
  readonly fundingGap: ViewedFundingGap | undefined;
}) {
  const [showEliminated, setShowEliminated] = useState(false);
  const [showClosed, setShowClosed] = useState(false);
  const remaining = list.products.filter((entry) => REMAINING_GROUPS.includes(entry.group));
  const eliminated = list.products.filter((entry) => entry.group === 'NOT_MATCHING');
  const closed = list.products.filter((entry) => entry.group === 'CLOSED');
  const policy = tab === 'POLICY_FUND';
  const cards = (items: ProductMatch[]) => (
    <div className="candidate-list">
      {items.map((entry) => (
        <MatchCard
          key={`${entry.productKey}@${entry.version}`}
          match={entry}
          asOfDate={asOfDate}
          policy={policy}
          fundingGap={fundingGap}
        />
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
      <p className="note">{TAB_NOTES[tab]}</p>
      {policy && <p className="note">{LIMIT_NOTE}</p>}

      {list.products.length === 0 ? (
        <p className="empty-state">이 탭에는 공고가 없습니다.</p>
      ) : (
        <>
          <div className="candidate-group">
            <div className="group-head">
              <h3>남은 공고</h3>
            </div>
            <p className="note">
              남은 공고도 선정이 보장되지 않습니다. 카드에 없는 조건은 공고문에서 못 찾은 것이니 원 공고에서 확인하세요.
            </p>
            {remaining.length === 0 ? (
              <p className="empty-state">
                남은 공고가 없습니다.
                {eliminated.length > 0 && ' 뺀 공고는 아래에 있습니다.'}
              </p>
            ) : (
              cards(remaining)
            )}
          </div>

          {eliminated.length > 0 && (
            <div className="candidate-group separated-group">
              <div className="group-head">
                <h3>조건에 안 맞아 뺀 공고</h3>
                <button
                  type="button"
                  className="button small"
                  aria-expanded={showEliminated}
                  onClick={() => setShowEliminated((current) => !current)}
                >
                  {showEliminated ? '숨기기' : `${numberFormat.format(eliminated.length)}건 보기`}
                </button>
              </div>
              <p className="note">AI가 조건을 잘못 읽었을 수 있습니다. 찾는 공고가 안 보이면 여기서 확인하세요.</p>
              {showEliminated && cards(eliminated)}
            </div>
          )}

          {closed.length > 0 && (
            <div className="candidate-group separated-group">
              <div className="group-head">
                <h3>마감</h3>
                <button
                  type="button"
                  className="button small"
                  aria-expanded={showClosed}
                  onClick={() => setShowClosed((current) => !current)}
                >
                  {showClosed ? '마감된 공고 숨기기' : `마감된 공고 ${numberFormat.format(closed.length)}건 보기`}
                </button>
              </div>
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
  asOfDate,
  policy,
  fundingGap,
}: {
  readonly match: ProductMatch;
  readonly asOfDate: string;
  readonly policy: boolean;
  readonly fundingGap: ViewedFundingGap | undefined;
}) {
  const closed = closedText(match);
  const applicationText = applicationStateText(match, asOfDate);
  const { aiPeriod, unconfirmedReasons } = match.application;
  const sections = conditionSections(match.conditions);
  const conditionItem = (condition: ConditionMatch) => (
    <ConditionItem
      key={condition.key}
      condition={condition}
      regionNote={match.operatorRegionNote}
      titleRegionMark={match.titleRegionMark}
    />
  );
  return (
    <article className="panel candidate-card">
      <div className="candidate-head">
        <div>
          <h4>{match.name}</h4>
          <p className="candidate-org">{match.organization}</p>
        </div>
        <div className="candidate-tags">
          {(match.group === 'NOT_MATCHING' || match.group === 'CLOSED') && (
            <span className={`candidate-status status-${match.group.toLowerCase()}`}>
              {FUNDING_GROUP_BADGE_LABELS[match.group]}
            </span>
          )}
          {applicationText !== null && (
            <span className={`application-badge application-${applicationState(match.application).toLowerCase()}`}>
              {applicationText}
            </span>
          )}
          {match.supportType !== 'UNKNOWN' && (
            <span className={`support-badge support-${match.supportType.toLowerCase()}`}>
              {SUPPORT_TYPE_LABELS[match.supportType]}
            </span>
          )}
          {match.automation && <span className="auto-badge">자동 수집</span>}
        </div>
      </div>

      {(closed !== null || unconfirmedReasons.length > 0) && (
        <ul className="reason-list application-reasons">
          {closed !== null && <li>{closed}</li>}
          {unconfirmedReasons.map((reason) => (
            <li key={reason}>{unconfirmedReasonText(reason, match)}</li>
          ))}
        </ul>
      )}

      <dl className="candidate-meta">
        <div>
          <dt>출처 기록</dt>
          <dd>{sourceRecordText(match)}</dd>
        </div>
        {aiPeriod.status === 'READ' && (
          <div>
            <dt>AI가 읽은 신청기간</dt>
            <dd>
              {aiPeriod.source === 'AI' ? (
                <>
                  {aiPeriodValueText(aiPeriod.value, aiPeriod.quote)}
                  <q className="match-quote">{aiPeriod.quote}</q>
                </>
              ) : (
                aiPeriodText(aiPeriod.value)
              )}
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

      {sections.stated.length > 0 && (
        <>
          <h5 className="match-section-title">공고가 밝힌 조건</h5>
          <ul className="match-conditions" aria-label="공고가 밝힌 조건">
            {sections.stated.map(conditionItem)}
          </ul>
        </>
      )}
      {sections.toCheck.length > 0 && (
        <>
          <h5 className="match-section-title">직접 확인할 조건</h5>
          <ul className="match-conditions" aria-label="직접 확인할 조건">
            {sections.toCheck.map(conditionItem)}
          </ul>
        </>
      )}
      {sections.hasUnread && <p className="match-reason">{UNREAD_NOTICE}</p>}

      {policy && (
        <div className="match-limit">
          <p>
            <strong>{limitText(match.limit)}</strong>
          </p>
          {fundingGap && <p>{fundingGapText(fundingGap)}</p>}
        </div>
      )}

      <div className="candidate-foot">
        {hasAiReading(match) && <p className="match-ai-notice">{AI_READING_NOTICE}</p>}
        <a className="button small" href={match.officialUrl} target="_blank" rel="noreferrer">
          원 공고 열기
        </a>
      </div>
    </article>
  );
}

function ConditionItem({
  condition,
  regionNote,
  titleRegionMark,
}: {
  readonly condition: ConditionMatch;
  readonly regionNote: string | null;
  readonly titleRegionMark: string | null;
}) {
  const value = conditionValueText(condition);
  const reason = checkReasonText(condition, titleRegionMark);
  const { reading } = condition;
  return (
    <li className="match-condition">
      <div className="match-condition-head">
        <strong>{CONDITION_LABELS[condition.key]}</strong>
        <span className={`condition-verdict verdict-${condition.verdict.toLowerCase()}`}>
          {MATCH_VERDICT_LABELS[condition.verdict]}
        </span>
      </div>
      {value !== null && <p className="match-condition-value">{value}</p>}
      {reading.status === 'READ' && reading.source === 'AI' && <q className="match-quote">{reading.quote}</q>}
      {reading.status === 'READ' && reading.source === 'TITLE' && (
        <p className="match-evidence">{titleRegionText(reading.mark)}</p>
      )}
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
