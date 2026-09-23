'use client';

import { useEffect, useState } from 'react';
import type { FranchiseBrand, FranchisePayload, FranchiseYearStats } from './types';

const numberFormat = new Intl.NumberFormat('ko-KR');
const formatWon = (value: string) => `${numberFormat.format(BigInt(value))}원`;
const formatCount = (value: number) => `${numberFormat.format(value)}개`;

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; payload: FranchisePayload }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

function money(value: string | null, missing = '미기재'): string {
  return value === null ? missing : formatWon(value);
}

// 모든 수치가 0인 해는 신규 브랜드인지 미기재인지 알 수 없으므로 0개로 보여 주지 않는다.
function stores(stats: FranchiseYearStats): string {
  return stats.statusReported ? formatCount(stats.storeCount) : '현황 없음';
}

function storeChange(brand: FranchiseBrand): string {
  const previous = brand.history.find((item) => item.disclosureYear === brand.latest.disclosureYear - 1);
  if (!previous) return '전년 자료 없음';
  if (!previous.statusReported || !brand.latest.statusReported) return '전년 대비 비교 불가(현황 없음)';
  const diff = brand.latest.storeCount - previous.storeCount;
  return `전년 대비 ${diff > 0 ? '+' : ''}${numberFormat.format(diff)}개`;
}

export default function FranchisePanel({
  industryCode,
  savedMonthlyRevenue,
}: Readonly<{ industryCode: '' | 'CS100001' | 'CS100010'; savedMonthlyRevenue: string | null }>) {
  const [query, setQuery] = useState('');
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [selectedId, setSelectedId] = useState('');

  useEffect(() => {
    if (!industryCode) return;
    let cancelled = false;
    const params = new URLSearchParams({ industryCode, limit: '10' });
    if (query.trim()) params.set('q', query.trim());
    // 입력이 멈춘 뒤에만 조회한다.
    const timer = window.setTimeout(() => {
      setState((current) => (current.kind === 'ready' ? current : { kind: 'loading' }));
      void fetch(`/api/franchises?${params.toString()}`, { headers: { accept: 'application/json' } })
        .then(async (response) => {
          if (cancelled) return;
          if (response.status === 503) return setState({ kind: 'unavailable' });
          if (!response.ok) throw new Error('프랜차이즈 자료를 불러오지 못했습니다.');
          setState({ kind: 'ready', payload: (await response.json()) as FranchisePayload });
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setState({
              kind: 'error',
              message: error instanceof Error ? error.message : '프랜차이즈 자료를 불러오지 못했습니다.',
            });
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [industryCode, query]);

  if (!industryCode) {
    return (
      <section className="picker franchise-panel" aria-labelledby="franchise-title">
        <h2 id="franchise-title">프랜차이즈 참고</h2>
        <p className="picker-note">사업 조건에서 업종을 고르면 공정위 정보공개서의 브랜드 현황을 보여 드립니다.</p>
      </section>
    );
  }

  const payload = state.kind === 'ready' ? state.payload : null;
  const selected = payload
    ? (payload.brands.find((brand) => brand.id === selectedId) ?? payload.brands[0] ?? null)
    : null;

  return (
    <section className="picker franchise-panel" aria-labelledby="franchise-title">
      <h2 id="franchise-title">프랜차이즈 참고</h2>
      {payload && (
        <p className="picker-note reference-lead">
          {payload.source.latestDisclosureYear}년 정보공개서({payload.source.latestPerformanceYear}년 실적) 기준{' '}
          {payload.industry.label} 브랜드 {numberFormat.format(payload.summary.brandCount)}개 중 가맹점이 있는 곳{' '}
          {numberFormat.format(payload.summary.brandsWithStores)}개, 평균매출을 공개한 곳{' '}
          {numberFormat.format(payload.summary.brandsWithSales)}개입니다. 전국 평균이며 재무계획에 자동으로 넣지
          않습니다.
        </p>
      )}
      <div className="select-row reference-select-row">
        <label className="field">
          <span>브랜드 검색</span>
          <span className="input-wrap">
            <input
              className="text-input"
              type="search"
              value={query}
              maxLength={40}
              placeholder="브랜드명이나 가맹본부명"
              onChange={(event) => setQuery(event.target.value)}
            />
          </span>
          <small>검색하지 않으면 가맹점이 많은 순서로 10개를 보여 드립니다.</small>
        </label>
      </div>
      {state.kind === 'loading' || state.kind === 'idle' ? (
        <p className="picker-note" role="status">
          프랜차이즈 자료를 불러오고 있습니다.
        </p>
      ) : state.kind === 'unavailable' ? (
        <p className="picker-note" role="status">
          공정위 가맹정보가 아직 준비되지 않았습니다. 자료가 적재되면 이곳에 표시됩니다.
        </p>
      ) : state.kind === 'error' ? (
        <p className="inline-error" role="alert">
          {state.message}
        </p>
      ) : payload && payload.brands.length === 0 ? (
        <p className="picker-note" role="status">
          ‘{payload.query}’와 일치하는 {payload.industry.label} 브랜드가 없습니다.
        </p>
      ) : payload && selected ? (
        <>
          <div className="table-scroll franchise-list">
            <table>
              <caption className="table-note">
                {payload.query ? `검색 결과 ${numberFormat.format(payload.totalMatches)}개` : '가맹점 수 상위 브랜드'}
                {payload.totalMatches > payload.brands.length ? ` 중 ${payload.brands.length}개` : ''}
              </caption>
              <thead>
                <tr>
                  <th scope="col">브랜드</th>
                  <th scope="col">가맹점 수</th>
                  <th scope="col">연 평균매출</th>
                </tr>
              </thead>
              <tbody>
                {payload.brands.map((brand) => (
                  <tr key={brand.id} className={brand.id === selected.id ? 'selected' : ''}>
                    <td>
                      <button
                        type="button"
                        className="link-button"
                        aria-pressed={brand.id === selected.id}
                        onClick={() => setSelectedId(brand.id)}
                      >
                        {brand.brandName}
                      </button>
                    </td>
                    <td>{stores(brand.latest)}</td>
                    <td>{money(brand.latest.averageSalesWon)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <FranchiseDetail brand={selected} payload={payload} savedMonthlyRevenue={savedMonthlyRevenue} />
        </>
      ) : null}
    </section>
  );
}

function FranchiseDetail({
  brand,
  payload,
  savedMonthlyRevenue,
}: Readonly<{ brand: FranchiseBrand; payload: FranchisePayload; savedMonthlyRevenue: string | null }>) {
  const { latest } = brand;
  const costs = latest.startupCosts;
  const change = storeChange(brand);
  return (
    <div className="franchise-detail">
      <h3>
        {brand.brandName}
        <span>
          {brand.corpName} · {brand.industryMiddle}
        </span>
      </h3>
      <div className="summary-grid reference-summary">
        <div>
          <span>가맹점 수({latest.performanceYear}년 말)</span>
          <strong>{stores(latest)}</strong>
          <small>{change}</small>
        </div>
        <div>
          <span>가맹점 연 평균매출</span>
          <strong>{money(latest.averageSalesWon)}</strong>
          <small>
            {latest.averageMonthlySalesWon
              ? `월 평균 약 ${formatWon(latest.averageMonthlySalesWon)}`
              : '가맹본부 미기재'}
          </small>
        </div>
        <div>
          <span>3.3㎡당 연 평균매출</span>
          <strong>{money(latest.averageSalesPerAreaWon)}</strong>
          <small>{latest.performanceYear}년 실적</small>
        </div>
        <div>
          <span>창업 금액(정보공개서)</span>
          <strong>{costs ? money(costs.totalWon) : '자료 없음'}</strong>
          <small>{costs ? '기타에 인테리어·설비 등 포함' : '이번 적재본에 창업 금액이 없습니다.'}</small>
        </div>
      </div>

      <p className="picker-note">
        {latest.statusReported ? (
          <>
            {latest.performanceYear}년 신규 개점 {formatCount(latest.newStoreCount)} · 계약 종료{' '}
            {formatCount(latest.contractEndCount)} · 계약 해지 {formatCount(latest.contractCancelCount)} · 명의 변경{' '}
            {formatCount(latest.ownershipChangeCount)}
          </>
        ) : (
          `${latest.performanceYear}년 가맹점·개폐점 현황이 없습니다(0 또는 미기재).`
        )}
      </p>

      {savedMonthlyRevenue !== null && latest.averageMonthlySalesWon !== null && (
        <p className="funding-position">
          이 계획에 저장된 월매출 가정: {formatWon(savedMonthlyRevenue)}. 이 브랜드 가맹점의 전국 월 평균은 약{' '}
          {formatWon(latest.averageMonthlySalesWon)}입니다. 입지·면적에 따라 크게 다르므로 참고로만 보세요.
        </p>
      )}

      <div className="reference-detail-grid">
        <div>
          <h3>연도별 추이</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">실적 연도</th>
                  <th scope="col">가맹점 수</th>
                  <th scope="col">연 평균매출</th>
                </tr>
              </thead>
              <tbody>
                {brand.history.map((item: FranchiseYearStats) => (
                  <tr key={item.disclosureYear}>
                    <td>{item.performanceYear}년</td>
                    <td>{stores(item)}</td>
                    <td>
                      {item.averageSalesWon ? (
                        formatWon(item.averageSalesWon)
                      ) : (
                        <span className="missing-value">미기재</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3>창업 금액 구성</h3>
          {costs ? (
            <table>
              <tbody>
                {(
                  [
                    ['가맹금', costs.franchiseFeeWon],
                    ['교육비', costs.educationFeeWon],
                    ['보증금', costs.depositWon],
                    ['기타(인테리어·설비 등)', costs.otherCostWon],
                    ['합계', costs.totalWon],
                  ] as const
                ).map(([label, value]) => (
                  <tr key={label}>
                    <th scope="row">{label}</th>
                    <td>{money(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="picker-note">이번 적재본에는 창업 금액이 포함되지 않았습니다.</p>
          )}
        </div>
      </div>

      <details className="reference-source">
        <summary>기준과 출처</summary>
        <ul>
          {[...payload.definitions, ...payload.limitations].map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="source-link">
          <a href={payload.source.sourceUrl} target="_blank" rel="noreferrer">
            {payload.source.name}
          </a>{' '}
          ·{' '}
          <a href={payload.source.compareUrl} target="_blank" rel="noreferrer">
            공정위 정보공개서 비교
          </a>{' '}
          · 적재 {new Date(payload.source.retrievedAt).toLocaleDateString('ko-KR')}
        </p>
      </details>
    </div>
  );
}
