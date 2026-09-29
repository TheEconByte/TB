'use client';

import Decimal from 'decimal.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import ReportNav from '@/components/ReportNav';
import { formatManWon, formatWonExact } from '@/lib/format-won';
import { ColumnChart, LineChart, ShareBars, shares, type ChartDatum } from './ReportCharts';
import type { ProvisionalQuarterSales } from './provisional';
import {
  MARKET_LIMITATIONS,
  type AreaInfo,
  type IndustryInfo,
  type MarketAreaList,
  type MarketReport,
  type QuarterIndicatorRow,
  type ReleaseInfo,
} from './types.ts';
import type { BusinessCategoryInfo, BusinessSummary } from '@/features/business-directory/types';

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
  const [areas, setAreas] = useState<AreaInfo[]>([]);
  const [selection, setSelection] = useState('');
  const [industryCode, setIndustryCode] = useState('');
  const [summary, setSummary] = useState<MarketReport | null>(null);
  const [businessCategories, setBusinessCategories] = useState<BusinessCategoryInfo[]>([]);
  const [businessCategoryMessage, setBusinessCategoryMessage] =
    useState('소진공 세부 업종 스냅샷을 확인하고 있습니다.');
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
        setBusinessCategoryMessage(businessData.nullReason ?? '활성 소진공 스냅샷 기준입니다.');
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
    if (areaValue === '' || nextIndustryCode === '') {
      setSummary(null);
      setSummaryError(null);
      setSummaryLoading(false);
      return;
    }
    const [areaType, areaCode] = areaValue.split(':');
    setSummaryLoading(true);
    setSummaryError(null);
    try {
      const data = await request<MarketReport>(
        `/api/markets/report?areaType=${encodeURIComponent(areaType ?? '')}&areaCode=${encodeURIComponent(areaCode ?? '')}&industryCode=${encodeURIComponent(nextIndustryCode)}`,
      );
      if (requestId !== latestSummaryRequest.current) return;
      setSummary(data);
      setActiveRelease(data.release);
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
    setAreaError(null);
    if (next === '') {
      setAreas([]);
      return;
    }
    setAreasLoading(true);
    try {
      const data = await request<MarketAreaList>(`/api/markets/areas?districtCode=${encodeURIComponent(next)}`);
      if (requestId !== latestAreaRequest.current) return;
      setAreas(data.areas);
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
  const filteredBusinessCategories = businessCategories.filter(
    (category) => category.marketIndustryCode === industryCode,
  );
  const selectedBusinessCategory =
    businessCategories.find((category) => category.code === detailedIndustryCode) ?? null;
  const latestLabel = summary?.quarters.at(-1)?.label ?? null;

  const competition = (
    <>
      {!detailedIndustryCode && !businessLoading && (
        <p className="empty-state">
          위 조건에서 세부 업종을 고르면 {districtCode ? '이 자치구의' : '자치구'} 소진공 점포 스냅샷으로 경쟁 점포를
          보여 줘요.
        </p>
      )}
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
    </>
  );

  return (
    <>
      <ReportNav active="markets" meta={latestLabel ? `기준 ${latestLabel}` : null} />
      <main className="report-page">
        <section className="report-head">
          <p className="report-notice">
            <span className="report-tag">공개 데이터</span>
            서울시 상권분석서비스 관측값이며 개인 예상매출이 아니에요. 로그인 없이 볼 수 있어요.
          </p>
          {summary ? (
            <h1>
              서울시 {summary.area.districtName} {summary.area.displayName} <em>{summary.industry.displayName}</em> 상권
              분석
            </h1>
          ) : (
            <h1>상권 분석 보고서</h1>
          )}
          <p className="report-lead">
            {summary
              ? `${summary.area.displayName} 상권에서 ${summary.industry.displayName} 창업에 참고할 공개 지표를 모았어요.`
              : '자치구 → 상권 → 업종 순으로 고르면 공개 지표로 보고서를 만들어요.'}
          </p>
          {summary && (
            <ul className="report-chips" aria-label="보고서 조건">
              <li>
                <span>자치구</span>
                {summary.area.districtName}
              </li>
              <li>
                <span>상권</span>
                {summary.area.displayName} · {summary.area.areaTypeName}
              </li>
              <li>
                <span>업종</span>
                {summary.industry.displayName} 전체
              </li>
              <li>
                <span>경쟁 범위</span>
                {selectedBusinessCategory ? selectedBusinessCategory.name : '세부 업종 미선택'}
              </li>
            </ul>
          )}
        </section>

        {booting && (
          <p className="loading-state" role="status">
            상권 데이터를 확인하고 있습니다.
          </p>
        )}

        {!booting && bootError && (
          <div className="error-box" role="alert">
            <h2>상권 데이터를 불러오지 못했습니다.</h2>
            <p>{bootError}</p>
          </div>
        )}

        {!booting && !bootError && !activeRelease && (
          <div className="empty-panel" role="status">
            <h2>활성 상권 릴리스가 없습니다.</h2>
            <p>
              운영자가 <code>npm --prefix app run market:load</code>로 검증된 릴리스를 활성화하기 전까지는 조회할 상권
              지표가 없습니다. 자료가 없는 상태를 0으로 대신 표시하지 않습니다.
            </p>
          </div>
        )}

        {!booting && activeRelease && (
          <>
            <section className="picker report-picker" aria-labelledby="market-picker">
              <h2 id="market-picker">조건 선택</h2>
              <div className="select-row market-select-row">
                <label className="field">
                  <span>자치구</span>
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
                  <span>상권</span>
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
                    {areas.map((area) => (
                      <option key={areaSelectionValue(area)} value={areaSelectionValue(area)}>
                        {area.displayName} · {area.areaTypeName}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>업종 (매출·고객 범위)</span>
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
                    {industries.map((industry) => (
                      <option key={industry.code} value={industry.code}>
                        {industry.displayName} ({industry.code})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span>세부 업종 (경쟁 범위)</span>
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
                          ? '활성 세부 업종 자료 없음'
                          : '선택하지 않음'}
                    </option>
                    {filteredBusinessCategories.map((category) => (
                      <option key={category.code} value={category.code}>
                        {category.name} ({category.code})
                      </option>
                    ))}
                  </select>
                  <small>{businessCategoryMessage}</small>
                </label>
              </div>
              <p className="picker-note">
                업종 표시명은 제품 문서의 이름을 우선하고 원본 명칭을 함께 보존합니다. 상권 표시명은 영역 파일 명칭을
                우선하며, 매출·점포 파일의 명칭이 다르면 보고서에 함께 표시합니다.
              </p>
            </section>

            <div className="report-results" aria-live="polite" aria-busy={summaryLoading}>
              {areaError && (
                <div className="error-box" role="alert">
                  <h2>상권 목록을 불러오지 못했습니다.</h2>
                  <p>{areaError}</p>
                </div>
              )}
              {districtCode !== '' && areas.length === 0 && !areasLoading && !areaError && (
                <p className="empty-state">이 자치구에는 등록된 상권이 없습니다.</p>
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
                <p className="empty-state">자치구 → 상권 → 업종 순으로 선택하면 보고서를 표시합니다.</p>
              )}
              {!summaryLoading && summary && (
                <MarketReportView
                  summary={summary}
                  selectedArea={selectedArea}
                  detailedCategoryName={selectedBusinessCategory?.name ?? null}
                  competition={competition}
                />
              )}
              {!summary && (businessLoading || businessError || businessSummary) && competition}
            </div>

            <section className="notice-box report-limits" aria-labelledby="market-limitations">
              <h2 id="market-limitations">이 보고서의 값이 무엇이고 무엇이 아닌지</h2>
              <ul>
                {MARKET_LIMITATIONS.map((limitation) => (
                  <li key={limitation}>{limitation}</li>
                ))}
              </ul>
            </section>

            <ReleaseCard release={activeRelease} />
          </>
        )}

        <footer>TrendBench · 공개 상권 지표 · 내부 MVP · 공개 출시 준비 완료 상태가 아닙니다.</footer>
      </main>
    </>
  );
}

function ReleaseCard({ release }: { readonly release: ReleaseInfo }) {
  return (
    <section className="release-card" aria-labelledby="market-release">
      <h2 id="market-release">데이터 출처와 기준</h2>
      <dl className="release-grid">
        <div>
          <dt>활성 릴리스</dt>
          <dd>{release.releaseKey}</dd>
        </div>
        <div>
          <dt>기준기간</dt>
          <dd>{release.basisPeriodLabel}</dd>
        </div>
        <div>
          <dt>원본 입수일</dt>
          <dd>{formatDate(release.retrievedAt)}</dd>
        </div>
        <div>
          <dt>활성화 시각</dt>
          <dd>{release.activatedAt ? new Date(release.activatedAt).toLocaleString('ko-KR') : '기록 없음'}</dd>
        </div>
        <div>
          <dt>적재 스키마 버전</dt>
          <dd>{release.schemaVersion}</dd>
        </div>
        <div>
          <dt>공간·지표 정의 버전</dt>
          <dd>{release.definitionVersion}</dd>
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
              {source.fileName} · {source.basisPeriod} · SHA-256 {source.sha256.slice(0, 16)}…
            </span>
          </li>
        ))}
      </ul>
      <p className="source-link">
        <a href={release.sourceUrl} target="_blank" rel="noreferrer">
          서울시 상권분석서비스 원본 안내 열기
        </a>
      </p>
    </section>
  );
}

type Change = { direction: 'UP' | 'DOWN' | 'SAME'; diff: string; percent: string | null };

function compareValues(current: string | number | null, previous: string | number | null): Change | null {
  if (current === null || previous === null) return null;
  const now = new Decimal(current);
  const before = new Decimal(previous);
  const diff = now.minus(before);
  return {
    direction: diff.isZero() ? 'SAME' : diff.isPositive() ? 'UP' : 'DOWN',
    diff: diff.abs().toFixed(0),
    percent: before.isZero()
      ? null
      : diff.abs().div(before).times(100).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1),
  };
}

// "전분기 대비 3개(+1.3%) 늘었어요."처럼 한 문장으로 쓴다. 비교할 값이 없으면 0으로 보지 않고
// 비교하지 않았다고 쓴다.
function describeChange(change: Change | null, base: string, format: (abs: string) => string): string {
  if (!change) return `${base} 값이 없어 비교하지 않았어요.`;
  if (change.direction === 'SAME') return `${base}와 같아요.`;
  const sign = change.direction === 'UP' ? '+' : '-';
  const percent = change.percent === null ? '' : `(${sign}${change.percent}%)`;
  return `${base} 대비 ${format(change.diff)}${percent} ${change.direction === 'UP' ? '늘었어요' : '줄었어요'}.`;
}

function sameQuarterLastYear(quarters: readonly QuarterIndicatorRow[], row: QuarterIndicatorRow) {
  const code = `${Number(row.quarter.slice(0, 4)) - 1}${row.quarter.slice(4)}`;
  return quarters.find((quarter) => quarter.quarter === code) ?? null;
}

function ReportSection({
  index,
  title,
  lead,
  children,
}: Readonly<{ index: number; title: string; lead?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <section className="report-section" aria-labelledby={`market-section-${index}`}>
      <h2 id={`market-section-${index}`}>
        {index}. {title}
      </h2>
      {lead && <div className="report-section-lead">{lead}</div>}
      {children}
    </section>
  );
}

function ProvisionalTag() {
  return <span className="provisional-tag">잠정</span>;
}

function MarketReportView({
  summary,
  selectedArea,
  detailedCategoryName,
  competition,
}: {
  readonly summary: MarketReport;
  readonly selectedArea: AreaInfo | null;
  readonly detailedCategoryName: string | null;
  readonly competition: React.ReactNode;
}) {
  const { quarters } = summary;
  const industry = summary.industry.displayName;
  const latest = quarters.at(-1) ?? null;
  const previous = quarters.length > 1 ? quarters[quarters.length - 2] : null;
  const lastYear = latest ? sameQuarterLastYear(quarters, latest) : null;
  const provisional = new Map<string, ProvisionalQuarterSales>(
    summary.provisionalSales.quarters.map((row) => [row.quarter, row]),
  );
  const latestProvisional = latest ? (provisional.get(latest.quarter) ?? null) : null;
  const previousProvisional = previous ? (provisional.get(previous.quarter) ?? null) : null;
  const observedQuarters = quarters.filter((quarter) => quarter.salesStatus === 'OBSERVED').length;
  const statusLabel =
    summary.dataStatus === 'AVAILABLE'
      ? `가용 분기 ${quarters.length}개 모두 매출 원값이 있습니다.`
      : summary.dataStatus === 'PARTIAL'
        ? `가용 분기 ${quarters.length}개 중 매출 원값이 있는 분기 ${observedQuarters}개입니다.`
        : '이 상권·업종 조합의 관측 자료가 없습니다.';

  const series = (value: (quarter: QuarterIndicatorRow) => number | null): ChartDatum[] =>
    quarters.map((quarter) => ({ key: quarter.quarter, label: shortQuarter(quarter.quarter), value: value(quarter) }));
  const provisionalSeries = (field: keyof Omit<ProvisionalQuarterSales, 'quarter'>) =>
    series((quarter) => {
      const value = provisional.get(quarter.quarter)?.[field] ?? null;
      return value === null ? null : Number(value);
    });
  const manWon = (value: number) => formatManWon(String(Math.round(value)));
  const manWonText = (value: string) => formatManWon(value);
  const countText = (value: string) => `${numberFormat.format(BigInt(value))}개`;
  const caseText = (value: string) => `${numberFormat.format(BigInt(value))}건`;

  return (
    <>
      <ReportSection
        index={1}
        title="상권 개요와 집계 범위"
        lead="매출·고객 값은 서울시 상위 업종 전체, 경쟁 점포는 소진공 세부 업종 기준이에요. 두 범위를 섞어 읽지 마세요."
      >
        <div className="report-split">
          <dl className="fact-grid">
            <div>
              <dt>자치구</dt>
              <dd>{summary.area.districtName}</dd>
            </div>
            <div>
              <dt>상권 유형</dt>
              <dd>{summary.area.areaTypeName}</dd>
            </div>
            <div>
              <dt>상권 코드</dt>
              <dd>{summary.area.areaCode}</dd>
            </div>
            <div>
              <dt>가용 분기</dt>
              <dd>
                {quarters.length === 0
                  ? '자료 없음'
                  : `${quarters.length}개 · ${quarters[0].label} ~ ${quarters.at(-1)!.label}`}
              </dd>
            </div>
            <div>
              <dt>업종 원본 명칭</dt>
              <dd>
                {summary.industry.sourceName} ({summary.industry.code})
              </dd>
            </div>
            <div>
              <dt>상권 원본 명칭</dt>
              <dd>{summary.area.sourceName}</dd>
            </div>
          </dl>
          <div className="scope-stack">
            <div className="scope-card">
              <span>매출·고객 분석 범위</span>
              <strong>{summary.observedScope.label} 전체</strong>
              <p>{summary.observedScope.statement}</p>
            </div>
            <div className="scope-card secondary">
              <span>경쟁 점포 범위</span>
              <strong>{detailedCategoryName ? `${detailedCategoryName} 세부 업종` : '세부 업종 미선택'}</strong>
              <p>소진공 상가(상권)정보의 자치구 점포 스냅샷이며 매출 데이터가 아닙니다.</p>
            </div>
          </div>
        </div>
        {summary.area.nameMismatch && (
          <p className="name-mismatch">
            원본 명칭이 다릅니다: 영역 파일 <strong>{summary.area.sourceName}</strong>, 매출·점포 파일{' '}
            <strong>{summary.area.observedName}</strong>. 영역 파일 명칭을 표시명으로 사용합니다.
          </p>
        )}
        {!summary.area.nameMismatch && selectedArea?.observedName && (
          <p className="name-mismatch">매출·점포 파일의 관측 명칭: {selectedArea.observedName}</p>
        )}
        <div className={`data-status status-${summary.dataStatus.toLowerCase()}`} role="status">
          <strong>{statusLabel}</strong>
          {summary.dataStatusMessage && <span>{summary.dataStatusMessage}</span>}
        </div>
      </ReportSection>

      {!latest ? (
        <div className="empty-panel" role="status">
          <h2>자료 부족</h2>
          <p>
            {summary.area.displayName} · {industry} 조합에는 적재된 분기 지표가 없습니다. 값을 0으로 만들지 않고 자료
            부족으로 표시합니다. 다른 상권이나 업종을 선택해 주세요.
          </p>
        </div>
      ) : (
        <>
          <ReportSection
            index={2}
            title={`${industry} 점포 현황`}
            lead="점포 수는 매출과 같은 서울시 상위 업종 기준이에요. 세부 업종 경쟁 점포는 5번에서 따로 봐요."
          >
            <div className="report-split">
              <div className="report-block">
                <h3>a. 점포 수</h3>
                {latest.similarIndustryStoreCount === null ? (
                  <p className="report-sentence">{latest.label} 유사 업종 점포 수가 제공되지 않았어요.</p>
                ) : (
                  <p className="report-sentence">
                    {latest.label} 기준 {industry} 점포(유사 업종 점포 수)는{' '}
                    <strong>{formatCount(latest.similarIndustryStoreCount)}개</strong>예요.{' '}
                    {describeChange(
                      compareValues(latest.similarIndustryStoreCount, previous?.similarIndustryStoreCount ?? null),
                      '전분기',
                      countText,
                    )}
                    {lastYear &&
                      ` ${describeChange(
                        compareValues(latest.similarIndustryStoreCount, lastYear.similarIndustryStoreCount),
                        '전년 같은 분기',
                        countText,
                      )}`}
                  </p>
                )}
                <StoreMix quarter={latest} />
                <dl className="mini-stats">
                  <div>
                    <dt>{latest.label} 개업</dt>
                    <dd>{formatCount(latest.openedStoreCount)}개</dd>
                  </div>
                  <div>
                    <dt>{latest.label} 폐업</dt>
                    <dd>{formatCount(latest.closedStoreCount)}개</dd>
                  </div>
                </dl>
              </div>
              <div className="report-block">
                <h3>b. 점포 수 변화</h3>
                <p className="chart-unit">단위: 개 · 유사 업종 점포 수</p>
                <ColumnChart
                  title="분기별 유사 업종 점포 수"
                  points={series((quarter) => quarter.similarIndustryStoreCount)}
                  format={(value) => `${numberFormat.format(value)}개`}
                />
              </div>
            </div>
          </ReportSection>

          <ReportSection
            index={3}
            title={`${industry} 매출 현황`}
            lead={
              <>
                <p>
                  <ProvisionalTag /> {summary.provisionalSales.basis.statement} 계산 결과에 저장하지 않고 재무 가정에
                  자동으로 넣지 않아요.
                </p>
                <p className="basis-links">
                  근거({summary.provisionalSales.basis.decision}):{' '}
                  {summary.provisionalSales.basis.sources.map((source, index) => (
                    <span key={source.url}>
                      {index > 0 && ' · '}
                      <a href={source.url} target="_blank" rel="noreferrer">
                        {source.label}
                      </a>
                    </span>
                  ))}
                </p>
              </>
            }
          >
            <div className="report-split">
              <div className="report-block">
                <h3>
                  a. 월매출 <ProvisionalTag />
                </h3>
                {latestProvisional?.monthlySalesAmount ? (
                  <>
                    <p className="report-sentence">
                      {latest.label} {industry} 월매출(잠정)은{' '}
                      <strong>{formatManWon(latestProvisional.monthlySalesAmount)}</strong>이에요.{' '}
                      {describeChange(
                        compareValues(
                          latestProvisional.monthlySalesAmount,
                          previousProvisional?.monthlySalesAmount ?? null,
                        ),
                        '전분기',
                        manWonText,
                      )}
                    </p>
                    <p className="raw-value">
                      원값 {formatWonExact(latest.salesAmount!)} (당월_매출_금액)을 분기 월평균으로 해석했어요.
                    </p>
                  </>
                ) : (
                  <p className="report-sentence">{latest.label} 매출 원값이 제공되지 않아 월매출을 표시하지 않아요.</p>
                )}
                <p className="chart-unit">단위: 원 · 분기별 월매출(잠정)</p>
                <ColumnChart
                  title="분기별 월매출(잠정)"
                  points={provisionalSeries('monthlySalesAmount')}
                  format={manWon}
                />
              </div>
              <div className="report-block">
                <h3>
                  b. 점포당 월매출 <ProvisionalTag />
                </h3>
                {latestProvisional?.perStoreMonthlySalesAmount ? (
                  <>
                    <p className="report-sentence">
                      {latest.label} 점포당 월매출(잠정)은{' '}
                      <strong>{formatManWon(latestProvisional.perStoreMonthlySalesAmount)}</strong>이에요.{' '}
                      {describeChange(
                        compareValues(
                          latestProvisional.perStoreMonthlySalesAmount,
                          previousProvisional?.perStoreMonthlySalesAmount ?? null,
                        ),
                        '전분기',
                        manWonText,
                      )}
                    </p>
                    <p className="raw-value">
                      원값 {formatWonExact(latest.salesAmount!)} ÷ 유사 업종 점포{' '}
                      {formatCount(latest.similarIndustryStoreCount)}개 ={' '}
                      {formatWonExact(latestProvisional.perStoreMonthlySalesAmount)}. 상권 평균이며 개인 예상매출이
                      아니에요.
                    </p>
                  </>
                ) : (
                  <p className="report-sentence">
                    매출 원값이나 유사 업종 점포 수가 없어 {latest.label} 점포당 월매출을 계산하지 않았어요.
                  </p>
                )}
                <p className="chart-unit">단위: 원 · 분기별 점포당 월매출(잠정)</p>
                <ColumnChart
                  title="분기별 점포당 월매출(잠정)"
                  points={provisionalSeries('perStoreMonthlySalesAmount')}
                  format={manWon}
                />
              </div>
            </div>
            <div className="report-split">
              <div className="report-block">
                <h3>c. 매출 건수</h3>
                {latest.salesCount ? (
                  <p className="report-sentence">
                    {latest.label} 매출 건수 원값은 <strong>{caseText(latest.salesCount)}</strong>이에요.{' '}
                    {describeChange(compareValues(latest.salesCount, previous?.salesCount ?? null), '전분기', caseText)}{' '}
                    방문자·주문자 수가 아니에요.
                  </p>
                ) : (
                  <p className="report-sentence">{latest.label} 매출 건수 원값이 제공되지 않았어요.</p>
                )}
                <p className="chart-unit">단위: 건 · 매출 건수 원값</p>
                <ColumnChart
                  title="분기별 매출 건수 원값"
                  points={series((quarter) => (quarter.salesCount === null ? null : Number(quarter.salesCount)))}
                  format={(value) => `${numberFormat.format(value)}건`}
                />
              </div>
              <div className="report-block">
                <h3>d. 결제 1건당 평균 금액</h3>
                {latestProvisional?.averagePaymentAmount ? (
                  <>
                    <p className="report-sentence">
                      {latest.label} 결제 1건당 평균 금액은{' '}
                      <strong>{formatWonExact(latestProvisional.averagePaymentAmount)}</strong>이에요.{' '}
                      {describeChange(
                        compareValues(
                          latestProvisional.averagePaymentAmount,
                          previousProvisional?.averagePaymentAmount ?? null,
                        ),
                        '전분기',
                        formatWonExact,
                      )}
                    </p>
                    <p className="raw-value">
                      매출 원값 ÷ 매출 건수 원값. 같은 기간 값끼리 나눠 시간 단위 해석과 무관해요.
                    </p>
                  </>
                ) : (
                  <p className="report-sentence">매출 원값이나 건수가 없어 평균 금액을 계산하지 않았어요.</p>
                )}
                <p className="chart-unit">단위: 원</p>
                <LineChart
                  title="분기별 결제 1건당 평균 금액"
                  points={provisionalSeries('averagePaymentAmount')}
                  format={(value) => `${numberFormat.format(value)}원`}
                />
              </div>
            </div>
          </ReportSection>

          <ReportSection
            index={4}
            title="결제 고객 분석"
            lead={`${latest.label} 매출 금액의 분류별 비중이에요. 성별과 연령대는 따로 집계된 값이라 교차해서 읽지 않아요.`}
          >
            {latest.salesBreakdown ? (
              <CustomerBreakdown quarter={latest} />
            ) : (
              <p className="empty-state">{latest.label} 요일·시간대·성별·연령대 구성 자료가 제공되지 않았어요.</p>
            )}
          </ReportSection>

          <ReportSection
            index={5}
            title="세부 업종 경쟁 점포"
            lead="소진공 상가(상권)정보 스냅샷의 자치구 점포 수와 목록이에요. 상권이 아니라 자치구 범위이고 매출 자료가 아니에요."
          >
            {competition}
          </ReportSection>

          <ReportSection index={6} title="분기별 원본 지표">
            <div className="table-scroll">
              <table className="market-table">
                <caption>
                  {summary.area.displayName} · {industry} · 가용 분기 {quarters.length}개 · 가장 오래된 분기부터
                </caption>
                <thead>
                  <tr>
                    <th scope="col">분기</th>
                    <th scope="col">매출 원값 (원)</th>
                    <th scope="col">월매출 잠정 (원)</th>
                    <th scope="col">점포당 월매출 잠정 (원)</th>
                    <th scope="col">매출 건수 원값</th>
                    <th scope="col">일반 점포 수</th>
                    <th scope="col">유사 업종 점포 수</th>
                    <th scope="col">프랜차이즈 점포 수</th>
                    <th scope="col">개업 점포 수</th>
                    <th scope="col">폐업 점포 수</th>
                  </tr>
                </thead>
                <tbody>
                  {quarters.map((quarter) => (
                    <QuarterRow
                      key={quarter.quarter}
                      quarter={quarter}
                      provisional={provisional.get(quarter.quarter)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="table-note">
              금액은 API에서 원 단위 정수 문자열로 전달되며, 표에서는 천 단위 구분만 넣었습니다. 없는 값은 0이 아니라
              자료 부족으로 표시합니다.
            </p>
            <details className="report-details">
              <summary>지표 정의와 원본 열</summary>
              <div className="table-scroll">
                <table className="market-table indicator-table">
                  <thead>
                    <tr>
                      <th scope="col">지표</th>
                      <th scope="col">단위</th>
                      <th scope="col">원본 열 (2024 / 2025)</th>
                      <th scope="col">해석 제한</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.indicators.map((indicator) => (
                      <tr key={indicator.key}>
                        <th scope="row">{indicator.label}</th>
                        <td>{indicator.unitConfirmed ? indicator.unit : '단위 미확정'}</td>
                        <td className="column-cell">
                          {indicator.sourceColumn[2024]} / {indicator.sourceColumn[2025]}
                        </td>
                        <td className="note-cell">{indicator.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </ReportSection>
        </>
      )}
    </>
  );
}

// 일반 점포와 프랜차이즈 점포의 구성. 두 값 중 하나라도 없으면 비율을 만들지 않는다.
function StoreMix({ quarter }: { readonly quarter: QuarterIndicatorRow }) {
  const general = quarter.storeCount;
  const franchise = quarter.franchiseStoreCount;
  if (general === null || franchise === null || general + franchise === 0) {
    return <p className="table-note">일반·프랜차이즈 점포 구성 자료가 없어 비율을 표시하지 않아요.</p>;
  }
  const generalPercent = Math.round((general / (general + franchise)) * 1000) / 10;
  return (
    <div className="store-mix">
      <div className="store-mix-bar" role="img" aria-label={`일반 점포 ${general}개, 프랜차이즈 점포 ${franchise}개`}>
        <span className="mix-general" style={{ width: `${generalPercent}%` }} />
        <span className="mix-franchise" style={{ width: `${100 - generalPercent}%` }} />
      </div>
      <ul className="mix-legend">
        <li>
          <i className="mix-general" />
          일반 점포 {numberFormat.format(general)}개 ({generalPercent.toFixed(1)}%)
        </li>
        <li>
          <i className="mix-franchise" />
          프랜차이즈 {numberFormat.format(franchise)}개 ({(100 - generalPercent).toFixed(1)}%)
        </li>
      </ul>
    </div>
  );
}

function topShareLabel(points: readonly { key: string; label: string; salesAmount: string }[]): string | null {
  const rows = shares(points.map((point) => ({ key: point.key, label: point.label, amount: point.salesAmount })));
  const top = rows.reduce<(typeof rows)[number] | null>(
    (best, row) => (row.percent !== null && (best === null || row.percent > (best.percent ?? -1)) ? row : best),
    null,
  );
  return top?.label ?? null;
}

function CustomerBreakdown({ quarter }: { readonly quarter: QuarterIndicatorRow }) {
  const breakdown = quarter.salesBreakdown!;
  const toShare = (points: typeof breakdown.dayOfWeek) =>
    points.map((point) => ({ key: point.key, label: point.label, amount: point.salesAmount }));
  const toColumns = (points: typeof breakdown.dayOfWeek): ChartDatum[] =>
    shares(toShare(points)).map((row) => ({ key: row.key, label: row.label, value: row.percent }));
  const topAge = topShareLabel(breakdown.age);
  const topGender = topShareLabel(breakdown.gender);
  const topDay = topShareLabel(breakdown.dayOfWeek);
  const topTime = topShareLabel(breakdown.timeOfDay);
  const percent = (value: number) => `${value.toFixed(1)}%`;
  return (
    <>
      {topAge && topGender && topDay && topTime && (
        <p className="report-sentence">
          연령대는 <strong>{topAge}</strong>, 성별은 <strong>{topGender}</strong> 매출 비중이 가장 높고,{' '}
          <strong>{topDay}요일</strong>과 <strong>{topTime}</strong>에 매출이 가장 많아요.
        </p>
      )}
      <div className="report-split">
        <div className="report-block">
          <h3>a. 성별</h3>
          <ShareBars title="성별 매출 비중" points={toShare(breakdown.gender)} />
          <h3 className="block-subhead">b. 연령대</h3>
          <ShareBars title="연령대별 매출 비중" points={toShare(breakdown.age)} />
        </div>
        <div className="report-block">
          <h3>c. 요일별 매출 비중</h3>
          <p className="chart-unit">단위: % · 매출 금액 비중</p>
          <ColumnChart
            title="요일별 매출 비중"
            points={toColumns(breakdown.dayOfWeek)}
            format={percent}
            highlight="max"
          />
          <h3 className="block-subhead">d. 시간대별 매출 비중</h3>
          <p className="chart-unit">단위: % · 매출 금액 비중</p>
          <ColumnChart
            title="시간대별 매출 비중"
            points={toColumns(breakdown.timeOfDay)}
            format={percent}
            highlight="max"
          />
        </div>
      </div>
      <ul className="table-note">
        {breakdown.limitations.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </>
  );
}

function CompetitionPanel({ summary }: { readonly summary: BusinessSummary }) {
  return (
    <div className="competition-block">
      <p className="report-sentence">
        {summary.district.name} {summary.category.name} 점포는{' '}
        <strong>{numberFormat.format(summary.businessCount)}개</strong>예요. {summary.competitionScope.statement}
      </p>
      {summary.businesses.length === 0 ? (
        <p className="empty-state">해당 자치구에서 관측된 점포가 없습니다. 0건은 활성 스냅샷 조회 결과입니다.</p>
      ) : (
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
      )}
      {summary.truncated && (
        <p className="table-note">목록은 50개까지만 표시하며 총 개수는 전체 스냅샷을 기준으로 합니다.</p>
      )}
      <p className="table-note">
        기준일 {formatDate(summary.asOf)} · 릴리스 {summary.sourceRelease}
      </p>
    </div>
  );
}

function QuarterRow({
  quarter,
  provisional,
}: {
  readonly quarter: QuarterIndicatorRow;
  readonly provisional: ProvisionalQuarterSales | undefined;
}) {
  const won = (value: string | null | undefined) =>
    value === null || value === undefined ? (
      <span className="missing-value">자료 부족</span>
    ) : (
      numberFormat.format(BigInt(value))
    );
  return (
    <tr>
      <th scope="row">{quarter.label}</th>
      <td>{won(quarter.salesAmount)}</td>
      <td>{won(provisional?.monthlySalesAmount)}</td>
      <td>{won(provisional?.perStoreMonthlySalesAmount)}</td>
      <td>{won(quarter.salesCount)}</td>
      <td>{formatCount(quarter.storeCount)}</td>
      <td>{formatCount(quarter.similarIndustryStoreCount)}</td>
      <td>{formatCount(quarter.franchiseStoreCount)}</td>
      <td>{formatCount(quarter.openedStoreCount)}</td>
      <td>{formatCount(quarter.closedStoreCount)}</td>
    </tr>
  );
}
