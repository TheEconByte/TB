'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import QuarterTrendChart, { type ChartPoint } from './QuarterTrendChart';
import {
  MARKET_LIMITATIONS,
  type AreaInfo,
  type IndustryInfo,
  type MarketAreaList,
  type MarketReport,
  type QuarterIndicatorRow,
  type ReleaseInfo,
  type SalesBreakdownPoint,
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

  return (
    <main>
      <header>
        <Link href="/" className="brand">
          TrendBench<span>창업 준비의 기준</span>
        </Link>
        <div className="account-actions">
          <Link className="link-button" href="/">
            내 창업 계획
          </Link>
          <Link className="link-button" href="/funding">
            자금 후보
          </Link>
        </div>
      </header>

      <section className="hero market-hero">
        <p className="eyebrow">공개 상권 탐색</p>
        <h1>
          자치구에서 상권으로,
          <br />
          상권에서 업종으로.
        </h1>
        <p>
          서울시 상권분석서비스의 공개 원값을 그대로 보여줍니다. 로그인 없이 볼 수 있고, 개인 재무계획에는 값을 자동으로
          넣지 않습니다.
        </p>
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
          <section className="notice-box" aria-labelledby="market-limitations">
            <h2 id="market-limitations">이 화면의 값이 무엇이고 무엇이 아닌지</h2>
            <ul>
              {MARKET_LIMITATIONS.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </section>

          <ReleaseCard release={activeRelease} />

          <section className="picker" aria-labelledby="market-picker">
            <h2 id="market-picker">상권과 업종 선택</h2>
            <div className="select-row market-select-row">
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
                  {areas.map((area) => (
                    <option key={areaSelectionValue(area)} value={areaSelectionValue(area)}>
                      {area.displayName} · {area.areaTypeName}
                    </option>
                  ))}
                </select>
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
                  {industries.map((industry) => (
                    <option key={industry.code} value={industry.code}>
                      {industry.displayName} ({industry.code})
                    </option>
                  ))}
                </select>
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
                    {filteredBusinessCategories.length === 0 ? '활성 세부 업종 자료 없음' : '선택하지 않음'}
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
              우선하며, 매출·점포 파일의 명칭이 다르면 아래에 함께 표시합니다.
            </p>
          </section>

          {(industryCode || detailedIndustryCode) && (
            <section className="scope-grid" aria-label="데이터 집계 범위">
              <div className="scope-card">
                <span>매출·고객 분석</span>
                <strong>
                  {industries.find((item) => item.code === industryCode)?.displayName ?? '상위 업종 미선택'} 전체 기준
                </strong>
                <p>서울시 상권분석서비스(추정매출-상권) 관측값이며 개인 예상매출이 아닙니다.</p>
              </div>
              <div className="scope-card secondary">
                <span>경쟁 점포 현황</span>
                <strong>
                  {selectedBusinessCategory ? `${selectedBusinessCategory.name} 세부 업종 기준` : '세부 업종 미선택'}
                </strong>
                <p>소진공 상가(상권)정보의 점포 스냅샷이며 매출 데이터가 아닙니다.</p>
              </div>
            </section>
          )}

          <section className="market-results" aria-live="polite" aria-busy={summaryLoading}>
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
              <p className="empty-state">
                자치구 → 상권 → 업종 순으로 선택하면 가용 분기와 분기별 원본 지표를 표시합니다.
              </p>
            )}
            {!summaryLoading && summary && <SummaryPanel summary={summary} selectedArea={selectedArea} />}
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
        </>
      )}

      <footer>TrendBench · 공개 상권 지표 · 내부 MVP · 공개 출시 준비 완료 상태가 아닙니다.</footer>
    </main>
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

function SummaryPanel({
  summary,
  selectedArea,
}: {
  readonly summary: MarketReport;
  readonly selectedArea: AreaInfo | null;
}) {
  const points: ChartPoint[] = summary.quarters.map((quarter) => ({
    quarter: quarter.quarter,
    label: quarter.label,
    shortLabel: shortQuarter(quarter.quarter),
    amount: quarter.salesAmount === null ? null : Number(quarter.salesAmount),
  }));
  const observedQuarters = summary.quarters.filter((quarter) => quarter.salesStatus === 'OBSERVED').length;
  const statusLabel =
    summary.dataStatus === 'AVAILABLE'
      ? `가용 분기 ${summary.quarters.length}개 모두 매출 원값이 있습니다.`
      : summary.dataStatus === 'PARTIAL'
        ? `가용 분기 ${summary.quarters.length}개 중 매출 원값이 있는 분기 ${observedQuarters}개입니다.`
        : '이 상권·업종 조합의 관측 자료가 없습니다.';

  return (
    <>
      <div className="summary-head">
        <h2>{summary.area.displayName}</h2>
        <p>
          {summary.area.districtName} · {summary.area.areaTypeName} · 상권 코드 {summary.area.areaCode} · 업종{' '}
          {summary.industry.displayName} ({summary.industry.code})
        </p>
        <p>
          업종 원본 명칭 <strong>{summary.industry.sourceName}</strong> · 원천 분류{' '}
          {summary.industry.sourceCategoryVersion} · 상권 원본 명칭 <strong>{summary.area.sourceName}</strong>
        </p>
        {summary.area.nameMismatch && (
          <p className="name-mismatch">
            원본 명칭이 다릅니다: 영역 파일 <strong>{summary.area.sourceName}</strong>, 매출·점포 파일{' '}
            <strong>{summary.area.observedName}</strong>. 영역 파일 명칭을 표시명으로 사용합니다.
          </p>
        )}
        {!summary.area.nameMismatch && selectedArea?.observedName && (
          <p className="name-mismatch">매출·점포 파일의 관측 명칭: {selectedArea.observedName}</p>
        )}
      </div>

      <div className={`data-status status-${summary.dataStatus.toLowerCase()}`} role="status">
        <strong>{statusLabel}</strong>
        {summary.dataStatusMessage && <span>{summary.dataStatusMessage}</span>}
      </div>

      <div className="scope-card">
        <span>관측 데이터 범위</span>
        <strong>{summary.observedScope.label} 전체 기준</strong>
        <p>{summary.observedScope.statement}</p>
      </div>

      {summary.quarters.length === 0 ? (
        <div className="empty-panel" role="status">
          <h2>자료 부족</h2>
          <p>
            {summary.area.displayName} · {summary.industry.displayName} 조합에는 적재된 분기 지표가 없습니다. 값을 0으로
            만들지 않고 자료 부족으로 표시합니다. 다른 상권이나 업종을 선택해 주세요.
          </p>
        </div>
      ) : (
        <>
          <div className="table-card">
            <h3>분기별 매출 원값 추이 (단위 미확정)</h3>
            <QuarterTrendChart points={points} />
            <p className="table-note">
              세로 막대는 매출 원값을, 빗금 칸은 자료가 없는 분기를 나타냅니다. 정확한 값은 아래 표에 있습니다.
            </p>
          </div>

          {summary.quarters.at(-1)?.salesBreakdown && <SalesBreakdownPanel quarter={summary.quarters.at(-1)!} />}

          <div className="table-card">
            <h3>분기별 원본 지표 · 가장 오래된 분기부터</h3>
            <div className="table-scroll">
              <table className="market-table">
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
            <p className="table-note">
              매출 원값은 API에서 원 단위 정수 문자열로 전달되며, 표에서는 읽기 쉽도록 천 단위 구분만 넣었습니다. 점포
              수는 제공된 값만 그대로 표시하고, 없는 값은 0이 아니라 자료 부족으로 표시합니다.
            </p>
          </div>

          <div className="table-card">
            <h3>지표 정의와 원본 열</h3>
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
          </div>
        </>
      )}
    </>
  );
}

function SalesBreakdownPanel({ quarter }: { readonly quarter: QuarterIndicatorRow }) {
  const breakdown = quarter.salesBreakdown;
  if (!breakdown) return null;
  return (
    <div className="table-card">
      <h3>{quarter.label} 매출 구성 · 상위 업종 기준</h3>
      <p className="table-note">
        금액 비중은 각 분류 안에서만 계산합니다. 개인 고객 구성이나 세부 업종 구성으로 해석하지 않습니다.
      </p>
      <div className="breakdown-grid">
        <MetricBars title="요일별" points={breakdown.dayOfWeek} />
        <MetricBars title="시간대별" points={breakdown.timeOfDay} />
        <MetricBars title="성별" points={breakdown.gender} />
        <MetricBars title="연령대별" points={breakdown.age} />
      </div>
      <ul className="table-note">
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
    <div className="table-card">
      <h3>
        {summary.district.name} {summary.category.name} 경쟁 점포
      </h3>
      <div className="scope-card secondary">
        <span>경쟁 범위</span>
        <strong>{numberFormat.format(summary.businessCount)}개 점포</strong>
        <p>{summary.competitionScope.statement}</p>
      </div>
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
