'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QuarterTrendChart, { type ChartPoint } from './QuarterTrendChart';
import {
  MARKET_LIMITATIONS,
  type AreaInfo,
  type AreaListItem,
  type IndustryInfo,
  type MarketAreaList,
  type MarketReport,
  type QuarterIndicatorRow,
  type ReleaseInfo,
  type SalesBreakdownPoint,
} from './types.ts';
import type { BusinessCategoryInfo, BusinessSummary } from '@/features/business-directory/types';
import type { MarketScoreResponse } from './score/api.ts';
import { scoreApiUrl } from './score/handoff.ts';
import ScorePanel from './score/ScorePanel';

type District = { districtCode: string; districtName: string; areaCount: number };

const numberFormat = new Intl.NumberFormat('ko-KR');

async function request<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const body = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
  if (!response.ok) {
    const error = new Error(body?.error?.message ?? '요청을 처리하지 못했습니다.') as Error & { code?: string };
    error.code = body?.error?.code;
    throw error;
  }
  return body as T;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('ko-KR');
}

function formatCount(value: number | null): string {
  return value === null ? '자료 부족' : numberFormat.format(value);
}

function shortQuarter(quarter: string): string {
  return `${quarter.slice(2, 4)}Q${quarter.slice(4)}`;
}

function areaSelectionValue(area: AreaInfo): string {
  return `${area.areaType}:${area.areaCode}`;
}

// 서울시 추정매출은 점포가 적은 상권·업종에 값을 주지 않는다. 고른 뒤에야 자료 부족을 보지 않도록, 상권 목록이
// 알려 준 매출 분기 수로 자료가 없는 조합을 목록에서 뺀다. 키가 없으면 알 수 없으므로 빼지 않는다.
function hasNoSales(area: AreaListItem, industryCode: string): boolean {
  return area.salesQuarterCounts[industryCode] === 0;
}

// 요식업 어느 업종에도 매출 원값이 한 분기도 없는 상권. 고를 수 있어도 볼 자료가 없어 목록에서 빼고 뺀 수를 밝힌다.
function hasNoFoodSales(area: AreaListItem): boolean {
  const counts = Object.values(area.salesQuarterCounts);
  return counts.length > 0 && counts.every((count) => count === 0);
}

// A response from our own API always carries a Korean message. A transport
// failure does not, so fall back to a plain explanation instead of the
// browser's "Failed to fetch".
function describeError(error: unknown, fallback: string): string {
  const typed = error as Error & { code?: string };
  return typed && typed.code ? typed.message : fallback;
}

export default function MarketExplorer() {
  const [industries, setIndustries] = useState<IndustryInfo[]>([]);
  const [activeRelease, setActiveRelease] = useState<ReleaseInfo | null>(null);
  const [districts, setDistricts] = useState<District[]>([]);
  const [districtCode, setDistrictCode] = useState('');
  const [areas, setAreas] = useState<AreaListItem[]>([]);
  const [excludedAreaCount, setExcludedAreaCount] = useState(0);
  const [selection, setSelection] = useState('');
  const [industryCode, setIndustryCode] = useState('');
  const [summary, setSummary] = useState<MarketReport | null>(null);
  const [businessCategories, setBusinessCategories] = useState<BusinessCategoryInfo[]>([]);
  const [businessCategoryMessage, setBusinessCategoryMessage] = useState('세부 업종 목록을 불러오는 중…');
  const [detailedIndustryCode, setDetailedIndustryCode] = useState('');
  const [businessSummary, setBusinessSummary] = useState<BusinessSummary | null>(null);
  const [businessLoading, setBusinessLoading] = useState(false);
  const [businessError, setBusinessError] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [areasLoading, setAreasLoading] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [areaError, setAreaError] = useState<string | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  // 생존점수는 지표와 따로 불러온다. 점수 릴리스가 없거나 실패해도 지표는 그대로 보여 준다.
  const [score, setScore] = useState<MarketScoreResponse | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);
  const latestAreaRequest = useRef(0);
  const latestSummaryRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [industryData, businessData] = await Promise.all([
          request<{ activeRelease: ReleaseInfo | null; industries: IndustryInfo[] }>('/api/industries'),
          request<{ activeRelease: unknown; categories: BusinessCategoryInfo[]; nullReason: string | null }>(
            '/api/business-categories',
          ),
        ]);
        if (cancelled) return;
        setIndustries(industryData.industries);
        setActiveRelease(industryData.activeRelease);
        setBusinessCategories(businessData.categories);
        setBusinessCategoryMessage(businessData.nullReason ?? '소상공인시장진흥공단 점포 자료 기준');
        if (!industryData.activeRelease) return;
        const areaData = await request<MarketAreaList>('/api/markets/areas');
        if (cancelled) return;
        setDistricts(areaData.districts);
      } catch (error) {
        if (!cancelled) setBootError(describeError(error, '네트워크 또는 서버 상태를 확인해 주세요.'));
      } finally {
        if (!cancelled) setBooting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Loading runs from the selection handlers rather than an effect so a stale
  // response can never overwrite a newer selection.
  const loadSummary = useCallback(async (areaValue: string, nextIndustryCode: string) => {
    latestSummaryRequest.current += 1;
    const requestId = latestSummaryRequest.current;
    setScore(null);
    setScoreError(null);
    if (areaValue === '' || nextIndustryCode === '') {
      setSummary(null);
      setSummaryError(null);
      setSummaryLoading(false);
      return;
    }
    const [areaType, areaCode] = areaValue.split(':');
    setSummaryLoading(true);
    setSummaryError(null);
    const scoreRequest = request<MarketScoreResponse>(
      scoreApiUrl({ areaType: areaType ?? '', areaCode: areaCode ?? '', industryCode: nextIndustryCode }),
    ).then(
      (data) => ({ data, error: null }),
      (error: unknown) => ({ data: null, error: describeError(error, '생존점수를 불러오지 못했습니다.') }),
    );
    try {
      const data = await request<MarketReport>(
        `/api/markets/report?areaType=${encodeURIComponent(areaType ?? '')}&areaCode=${encodeURIComponent(areaCode ?? '')}&industryCode=${encodeURIComponent(nextIndustryCode)}`,
      );
      const scored = await scoreRequest;
      if (requestId !== latestSummaryRequest.current) return;
      setSummary(data);
      setActiveRelease(data.release);
      setScore(scored.data);
      setScoreError(scored.error);
    } catch (error) {
      if (requestId !== latestSummaryRequest.current) return;
      setSummary(null);
      setSummaryError(describeError(error, '네트워크 또는 서버 상태를 확인해 주세요.'));
    } finally {
      if (requestId === latestSummaryRequest.current) setSummaryLoading(false);
    }
  }, []);

  const changeDistrict = useCallback(async (next: string) => {
    latestAreaRequest.current += 1;
    const requestId = latestAreaRequest.current;
    latestSummaryRequest.current += 1;
    setDistrictCode(next);
    setSelection('');
    setIndustryCode('');
    setDetailedIndustryCode('');
    setBusinessSummary(null);
    setBusinessError(null);
    setSummary(null);
    setSummaryError(null);
    setSummaryLoading(false);
    setScore(null);
    setScoreError(null);
    setAreaError(null);
    setExcludedAreaCount(0);
    if (next === '') {
      setAreas([]);
      return;
    }
    setAreasLoading(true);
    try {
      const data = await request<MarketAreaList>(`/api/markets/areas?districtCode=${encodeURIComponent(next)}`);
      if (requestId !== latestAreaRequest.current) return;
      // 자치구마다 상권이 100개 가까이 되어 찾기 쉽게 이름 순으로 놓는다.
      setAreas(
        data.areas
          .filter((area) => !hasNoFoodSales(area))
          .sort(
            (a, b) =>
              a.displayName.localeCompare(b.displayName, 'ko') || a.areaTypeName.localeCompare(b.areaTypeName, 'ko'),
          ),
      );
      setExcludedAreaCount(data.areas.filter(hasNoFoodSales).length);
      setActiveRelease(data.release);
    } catch (error) {
      if (requestId !== latestAreaRequest.current) return;
      setAreas([]);
      setAreaError(describeError(error, '네트워크 또는 서버 상태를 확인해 주세요.'));
    } finally {
      if (requestId === latestAreaRequest.current) setAreasLoading(false);
    }
  }, []);

  const loadBusinessSummary = useCallback(async (nextDistrictCode: string, nextDetailedIndustryCode: string) => {
    if (!nextDistrictCode || !nextDetailedIndustryCode) {
      setBusinessSummary(null);
      setBusinessError(null);
      return;
    }
    setBusinessLoading(true);
    setBusinessError(null);
    try {
      const data = await request<BusinessSummary>(
        `/api/businesses/summary?districtCode=${encodeURIComponent(nextDistrictCode)}&detailedIndustryCode=${encodeURIComponent(nextDetailedIndustryCode)}`,
      );
      setBusinessSummary(data);
    } catch (error) {
      setBusinessSummary(null);
      setBusinessError(describeError(error, '세부 업종 경쟁 현황을 불러오지 못했습니다.'));
    } finally {
      setBusinessLoading(false);
    }
  }, []);

  const selectedArea = areas.find((area) => areaSelectionValue(area) === selection) ?? null;
  // 고른 업종이나 상권을 기준으로 매출 자료가 없는 상대 항목은 목록에 내지 않는다. 목록에서 고른 짝은 늘 자료가
  // 있으므로, 양쪽을 함께 걸러도 이미 고른 값이 목록에서 사라지지 않는다.
  const areaOptions = industryCode ? areas.filter((area) => !hasNoSales(area, industryCode)) : areas;
  const industryOptions = selectedArea
    ? industries.filter((industry) => !hasNoSales(selectedArea, industry.code))
    : industries;
  const selectedIndustryName = industries.find((item) => item.code === industryCode)?.displayName;
  const filteredBusinessCategories = businessCategories.filter(
    (category) => category.marketIndustryCode === industryCode,
  );
  const selectedBusinessCategory =
    businessCategories.find((category) => category.code === detailedIndustryCode) ?? null;

  return (
    <main>
      <div className="page-head">
        <h1>상권 조회</h1>
        <p>서울시 상권분석서비스와 소상공인시장진흥공단 점포 자료입니다. 로그인 없이 볼 수 있습니다.</p>
      </div>

      {booting && (
        <p className="loading-state" role="status">
          상권 자료를 불러오는 중…
        </p>
      )}

      {!booting && bootError && (
        <div className="error-box" role="alert">
          <h2>상권 자료를 불러오지 못했습니다.</h2>
          <p>{bootError}</p>
        </div>
      )}

      {!booting && !bootError && !activeRelease && (
        <div className="empty-panel" role="status">
          <h2>상권 자료가 아직 없습니다.</h2>
        </div>
      )}

      {!booting && activeRelease && (
        <div className="split-layout">
          {/* 고르는 칸이 먼저다. 주의할 점과 출처는 그 아래에 접어 둔다. */}
          <div className="split-aside">
            <section className="panel picker" aria-labelledby="market-picker">
              <h2 id="market-picker">상권·업종 고르기</h2>
              <div className="select-row">
                <label className="field">
                  <span>1. 자치구</span>
                  <select value={districtCode} onChange={(event) => void changeDistrict(event.target.value)}>
                    <option value="">자치구를 선택하세요</option>
                    {districts.map((district) => (
                      <option key={district.districtCode} value={district.districtCode}>
                        {district.districtName} ({numberFormat.format(district.areaCount)}개 상권)
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>2. 상권</span>
                  <select
                    value={selection}
                    disabled={areas.length === 0}
                    onChange={(event) => {
                      setSelection(event.target.value);
                      void loadSummary(event.target.value, industryCode);
                    }}
                  >
                    <option value="">
                      {areasLoading
                        ? '불러오는 중…'
                        : districtCode === ''
                          ? '자치구를 먼저 선택하세요'
                          : '상권을 선택하세요'}
                    </option>
                    {areaOptions.map((area) => (
                      <option key={areaSelectionValue(area)} value={areaSelectionValue(area)}>
                        {area.displayName} · {area.areaTypeName}
                      </option>
                    ))}
                  </select>
                  {(excludedAreaCount > 0 || areaOptions.length < areas.length) && (
                    <small>
                      {excludedAreaCount > 0 &&
                        `요식업 매출 자료가 없는 상권 ${numberFormat.format(excludedAreaCount)}곳은 목록에서 뺐습니다. `}
                      {areaOptions.length < areas.length &&
                        `${selectedIndustryName} 매출 자료가 없는 상권 ${numberFormat.format(areas.length - areaOptions.length)}곳도 뺐습니다.`}
                    </small>
                  )}
                </label>
                <label className="field">
                  <span>3. 업종</span>
                  <select
                    value={industryCode}
                    disabled={industries.length === 0}
                    onChange={(event) => {
                      setIndustryCode(event.target.value);
                      setDetailedIndustryCode('');
                      setBusinessSummary(null);
                      setBusinessError(null);
                      void loadSummary(selection, event.target.value);
                    }}
                  >
                    <option value="">업종을 선택하세요</option>
                    {industryOptions.map((industry) => (
                      <option key={industry.code} value={industry.code}>
                        {industry.displayName}
                      </option>
                    ))}
                  </select>
                  {industryOptions.length < industries.length && (
                    <small>
                      이 상권에 매출 자료가 없는 업종 {numberFormat.format(industries.length - industryOptions.length)}
                      개는 목록에서 뺐습니다.
                    </small>
                  )}
                </label>
                <label className="field">
                  <span>4. 세부 업종 경쟁 범위</span>
                  <select
                    value={detailedIndustryCode}
                    disabled={!industryCode || filteredBusinessCategories.length === 0}
                    onChange={(event) => {
                      setDetailedIndustryCode(event.target.value);
                      void loadBusinessSummary(districtCode, event.target.value);
                    }}
                  >
                    <option value="">
                      {!industryCode
                        ? '업종을 먼저 선택하세요'
                        : filteredBusinessCategories.length === 0
                          ? '세부 업종 자료 없음'
                          : '선택하지 않음'}
                    </option>
                    {filteredBusinessCategories.map((category) => (
                      <option key={category.code} value={category.code}>
                        {category.name}
                      </option>
                    ))}
                  </select>
                  <small>{businessCategoryMessage}</small>
                </label>
              </div>
            </section>

            <details className="panel">
              <summary>값을 볼 때 주의할 점</summary>
              <ul className="note">
                {MARKET_LIMITATIONS.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </details>

            <ReleaseCard release={activeRelease} />
          </div>

          <section className="split-main market-results" aria-live="polite" aria-busy={summaryLoading}>
            {areaError && (
              <div className="error-box" role="alert">
                <h2>상권 목록을 불러오지 못했습니다.</h2>
                <p>{areaError}</p>
              </div>
            )}
            {districtCode !== '' && areas.length === 0 && !areasLoading && !areaError && (
              <p className="empty-state">
                {excludedAreaCount > 0
                  ? '이 자치구에는 요식업 매출 자료가 있는 상권이 없습니다.'
                  : '이 자치구에는 등록된 상권이 없습니다.'}
              </p>
            )}
            {summaryLoading && (
              <p className="loading-state" role="status">
                분기 지표를 불러오는 중…
              </p>
            )}
            {!summaryLoading && summaryError && (
              <div className="error-box" role="alert">
                <h2>분기 지표를 불러오지 못했습니다.</h2>
                <p>{summaryError}</p>
              </div>
            )}
            {!summaryLoading && !summaryError && !summary && (
              <div className="empty-panel">
                <h2>상권과 업종을 고르면 볼 수 있는 자료</h2>
                <ul>
                  <li>상권 생존점수와 서울 내 순위(점수를 내는 업종만)</li>
                  <li>분기별 매출 추이와 요일·시간대·성별·연령대 구성</li>
                  <li>분기별 점포 수, 개업·폐업 점포 수</li>
                  <li>세부 업종을 고르면 같은 자치구의 경쟁 점포</li>
                </ul>
                <p>자치구 → 상권 → 업종을 고르세요.</p>
              </div>
            )}

            {!summaryLoading && summary && <SummaryHead summary={summary} selectedArea={selectedArea} />}

            {(industryCode || detailedIndustryCode) && (
              <section className="scope-grid" aria-label="데이터 집계 범위">
                <div>
                  <span>매출·고객 분석</span>
                  <strong>{selectedIndustryName ?? '상위 업종 미선택'} 전체 기준</strong>
                  <p>서울시 상권분석서비스(추정매출-상권) 관측값이며 개인 예상매출이 아닙니다.</p>
                </div>
                <div>
                  <span>경쟁 점포 현황</span>
                  <strong>
                    {selectedBusinessCategory ? `${selectedBusinessCategory.name} 세부 업종 기준` : '세부 업종 미선택'}
                  </strong>
                  <p>소진공 상가(상권)정보의 점포 목록입니다. 매출은 들어 있지 않습니다.</p>
                </div>
              </section>
            )}

            {!summaryLoading && summary && scoreError && (
              <div className="error-box" role="alert">
                <h2>상권 생존점수를 불러오지 못했습니다.</h2>
                <p>{scoreError} 아래 공개 지표는 그대로 볼 수 있습니다.</p>
              </div>
            )}
            {!summaryLoading && summary && score && <ScorePanel score={score} />}
            {!summaryLoading && summary && <SummaryBody summary={summary} />}
            {businessLoading && (
              <p className="loading-state" role="status">
                세부 업종 경쟁 현황을 불러오는 중…
              </p>
            )}
            {!businessLoading && businessError && (
              <div className="error-box" role="alert">
                <h2>경쟁 현황을 불러오지 못했습니다.</h2>
                <p>{businessError}</p>
              </div>
            )}
            {!businessLoading && businessSummary && <CompetitionPanel summary={businessSummary} />}
          </section>
        </div>
      )}
    </main>
  );
}

function ReleaseCard({ release }: { readonly release: ReleaseInfo }) {
  return (
    <details className="panel">
      <summary>데이터 출처 · {release.basisPeriodLabel}</summary>
      <dl className="release-grid">
        <div>
          <dt>릴리스</dt>
          <dd>{release.releaseKey}</dd>
        </div>
        <div>
          <dt>원본 입수일</dt>
          <dd>{formatDate(release.retrievedAt)}</dd>
        </div>
        <div>
          <dt>적재 범위</dt>
          <dd>
            상권 {numberFormat.format(release.areaCount)}개 · 분기 지표 {numberFormat.format(release.quarterlyRowCount)}
            행
          </dd>
        </div>
      </dl>
      <ul className="source-list">
        {release.sources.map((source) => (
          <li key={source.fileName}>
            <a href={source.url} target="_blank" rel="noreferrer">
              {source.datasetId} {source.datasetName}
            </a>
            <span>
              {source.fileName} · {source.basisPeriod}
            </span>
          </li>
        ))}
      </ul>
      <p className="source-link">
        <a href={release.sourceUrl} target="_blank" rel="noreferrer">
          서울시 상권분석서비스 원본 안내 열기
        </a>
      </p>
    </details>
  );
}

// 결과의 제목. 어느 상권·업종의 자료인지와 자료가 얼마나 있는지를 먼저 밝힌다.
function SummaryHead({
  summary,
  selectedArea,
}: {
  readonly summary: MarketReport;
  readonly selectedArea: AreaInfo | null;
}) {
  const observedQuarters = summary.quarters.filter((quarter) => quarter.salesStatus === 'OBSERVED').length;
  const statusLabel =
    summary.dataStatus === 'AVAILABLE'
      ? `가용 분기 ${summary.quarters.length}개 모두 매출 원값이 있습니다.`
      : summary.dataStatus === 'PARTIAL'
        ? `가용 분기 ${summary.quarters.length}개 중 매출 원값이 있는 분기 ${observedQuarters}개입니다.`
        : '이 상권·업종 조합의 관측 자료가 없습니다.';
  const observedName = summary.area.nameMismatch ? summary.area.observedName : selectedArea?.observedName;

  return (
    <div className="summary-head">
      <div>
        <h2>{summary.area.displayName}</h2>
        <p>
          {summary.area.districtName} · {summary.area.areaTypeName} · {summary.industry.displayName}
        </p>
        {observedName && <p className="name-mismatch">매출·점포 자료의 상권 이름: {observedName}</p>}
      </div>
      <div className={`data-status status-${summary.dataStatus.toLowerCase()}`} role="status">
        <strong>{statusLabel}</strong>
        {summary.dataStatusMessage && <span>{summary.dataStatusMessage}</span>}
      </div>
    </div>
  );
}

function SummaryBody({ summary }: { readonly summary: MarketReport }) {
  const points: ChartPoint[] = summary.quarters.map((quarter) => ({
    quarter: quarter.quarter,
    label: quarter.label,
    shortLabel: shortQuarter(quarter.quarter),
    amount: quarter.salesAmount === null ? null : Number(quarter.salesAmount),
  }));
  const latest = summary.quarters.at(-1);

  if (!latest) {
    return (
      <div className="empty-panel" role="status">
        <h2>자료 부족</h2>
        <p>
          {summary.area.displayName} · {summary.industry.displayName} 조합에는 분기 지표가 없습니다. 다른 상권이나
          업종을 선택해 주세요.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="panel">
        <h3>분기별 매출 원값 추이 (단위 미확정)</h3>
        <LatestQuarterStats quarter={latest} />
        <QuarterTrendChart points={points} />
        <p className="note">빗금 칸은 자료가 없는 분기입니다.</p>
      </div>

      {latest.salesBreakdown && <SalesBreakdownPanel quarter={latest} />}

      <div className="panel">
        <h3>분기별 지표</h3>
        <div className="table-scroll full-length">
          <table>
            <caption>
              {summary.area.displayName} · {summary.industry.displayName} · 가용 분기 {summary.quarters.length}개
            </caption>
            <thead>
              <tr>
                <th scope="col">분기</th>
                <th scope="col">매출 원값 (원)</th>
                <th scope="col">매출 건수 원값</th>
                <th scope="col">일반 점포 수</th>
                <th scope="col">유사 업종 점포 수</th>
                <th scope="col">프랜차이즈 점포 수</th>
                <th scope="col">개업 점포 수</th>
                <th scope="col">폐업 점포 수</th>
              </tr>
            </thead>
            <tbody>
              {summary.quarters.map((quarter) => (
                <QuarterRow key={quarter.quarter} quarter={quarter} />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <details className="panel">
        <summary>지표 정의</summary>
        <div className="table-scroll">
          <table className="indicator-table">
            <thead>
              <tr>
                <th scope="col">지표</th>
                <th scope="col">단위</th>
                <th scope="col">해석 제한</th>
              </tr>
            </thead>
            <tbody>
              {summary.indicators.map((indicator) => (
                <tr key={indicator.key}>
                  <th scope="row">{indicator.label}</th>
                  <td>{indicator.unitConfirmed ? indicator.unit : '단위 미확정'}</td>
                  <td className="note-cell">{indicator.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

// 표의 마지막 행(가장 최근 분기)을 표를 끝까지 내리지 않아도 보이게 위에 옮겨 적는다. 값과 표기는 표와 같다.
function LatestQuarterStats({ quarter }: { readonly quarter: QuarterIndicatorRow }) {
  return (
    <div className="summary-grid" role="group" aria-label={`${quarter.label} 지표`}>
      <div>
        <span>{quarter.label} 매출 원값</span>
        <strong>{quarter.salesAmount === null ? '자료 부족' : numberFormat.format(Number(quarter.salesAmount))}</strong>
      </div>
      <div>
        <span>일반 점포 수</span>
        <strong>{formatCount(quarter.storeCount)}</strong>
      </div>
      <div>
        <span>개업 점포 수</span>
        <strong>{formatCount(quarter.openedStoreCount)}</strong>
      </div>
      <div>
        <span>폐업 점포 수</span>
        <strong>{formatCount(quarter.closedStoreCount)}</strong>
      </div>
    </div>
  );
}

function SalesBreakdownPanel({ quarter }: { readonly quarter: QuarterIndicatorRow }) {
  const breakdown = quarter.salesBreakdown;
  if (!breakdown) return null;
  return (
    <div className="panel">
      <h3>{quarter.label} 매출 구성 · 상위 업종 기준</h3>
      <div className="breakdown-grid">
        <MetricBars title="요일별" points={breakdown.dayOfWeek} />
        <MetricBars title="시간대별" points={breakdown.timeOfDay} />
        <MetricBars title="성별" points={breakdown.gender} />
        <MetricBars title="연령대별" points={breakdown.age} />
      </div>
      <ul className="note">
        {breakdown.limitations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

function MetricBars({ title, points }: { readonly title: string; readonly points: SalesBreakdownPoint[] }) {
  const values = points.map((point) => BigInt(point.salesAmount));
  const total = values.reduce((sum, value) => sum + value, 0n);
  return (
    <section className="breakdown-card">
      <h4>{title}</h4>
      <div className="metric-bars">
        {points.map((point, index) => {
          const percent = total === 0n ? 0 : Number((values[index] * 1000n) / total) / 10;
          return (
            <div className="metric-row" key={point.key}>
              <span>{point.label}</span>
              <div className="metric-track">
                <span style={{ width: `${percent}%` }} />
              </div>
              <strong>{percent.toFixed(1)}%</strong>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CompetitionPanel({ summary }: { readonly summary: BusinessSummary }) {
  return (
    <div className="panel">
      <h3>
        {summary.district.name} {summary.category.name} 경쟁 점포
      </h3>
      <p className="competition-count">
        <strong>{numberFormat.format(summary.businessCount)}개 점포</strong>
      </p>
      <p className="note">{summary.competitionScope.statement}</p>
      {summary.businesses.length === 0 ? (
        <p className="empty-state">해당 자치구에서 관측된 점포가 없습니다.</p>
      ) : (
        // 점포가 많으면 목록이 결과 화면을 길게 늘려서 처음에는 접어 둔다. 점포 수는 위에 늘 보인다.
        <details>
          <summary>
            점포 목록 {numberFormat.format(summary.businesses.length)}곳 보기
            {summary.truncated && ` (전체 ${numberFormat.format(summary.businessCount)}곳 중 앞 50곳)`}
          </summary>
          <ul className="competition-list">
            {summary.businesses.map((business) => (
              <li key={business.sourceBusinessId}>
                <strong>
                  {business.businessName}
                  {business.branchName ? ` ${business.branchName}` : ''}
                </strong>
                <span>{business.roadAddress ?? business.lotAddress ?? '주소 자료 부족'}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="note">기준일 {formatDate(summary.asOf)}</p>
    </div>
  );
}

function QuarterRow({ quarter }: { readonly quarter: QuarterIndicatorRow }) {
  return (
    <tr>
      <th scope="row">{quarter.label}</th>
      <td>
        {quarter.salesAmount === null ? (
          <span className="missing-value">자료 부족</span>
        ) : (
          numberFormat.format(Number(quarter.salesAmount))
        )}
      </td>
      <td>
        {quarter.salesCount === null ? (
          <span className="missing-value">자료 부족</span>
        ) : (
          numberFormat.format(Number(quarter.salesCount))
        )}
      </td>
      <td>{formatCount(quarter.storeCount)}</td>
      <td>{formatCount(quarter.similarIndustryStoreCount)}</td>
      <td>{formatCount(quarter.franchiseStoreCount)}</td>
      <td>{formatCount(quarter.openedStoreCount)}</td>
      <td>{formatCount(quarter.closedStoreCount)}</td>
    </tr>
  );
}
