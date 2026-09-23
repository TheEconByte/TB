'use client';

import { useEffect, useMemo, useState } from 'react';
import type { BusinessProfileForm } from '@/features/business-profile/BusinessProfileWizard';
import { monthlyRentReferenceWon, squareMetersLabel } from './estimate';
import type { FloorCode, RentBenchmarkPayload, RentRegionBenchmark } from './types';

const numberFormat = new Intl.NumberFormat('ko-KR');
const formatWon = (value: string) => `${numberFormat.format(BigInt(value))}원`;

// 사업 조건의 층을 부동산원 층별 임대료의 층으로 옮긴다. "2층 이상"은 2층 값을 기준으로 보여 준다.
const PROFILE_FLOOR: Readonly<Record<Exclude<BusinessProfileForm['floor'], ''>, FloorCode>> = {
  BASEMENT_1: 'B1',
  GROUND_1: '1F',
  UPPER_2_PLUS: '2F',
};

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ready'; payload: RentBenchmarkPayload }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

function regionLabel(region: RentRegionBenchmark): string {
  if (region.level === 1) return '서울 전체';
  if (region.level === 2) return `${region.name} 권역 전체`;
  return region.name;
}

export default function RentBenchmarkPanel({
  profile,
  savedMonthlyRent,
}: Readonly<{ profile: BusinessProfileForm; savedMonthlyRent: string | null }>) {
  const [state, setState] = useState<LoadState>({ kind: 'idle' });
  const [selectedPath, setSelectedPath] = useState('');
  const { buildingType, districtCode } = profile;

  useEffect(() => {
    if (!buildingType) return;
    let cancelled = false;
    const query = new URLSearchParams({ buildingType });
    if (districtCode) query.set('districtCode', districtCode);
    const timer = window.setTimeout(() => {
      setState({ kind: 'loading' });
      void fetch(`/api/rent-benchmarks?${query.toString()}`, { headers: { accept: 'application/json' } })
        .then(async (response) => {
          if (cancelled) return;
          if (response.status === 503) return setState({ kind: 'unavailable' });
          if (!response.ok) throw new Error('임대료 자료를 불러오지 못했습니다.');
          setState({ kind: 'ready', payload: (await response.json()) as RentBenchmarkPayload });
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setState({
              kind: 'error',
              message: error instanceof Error ? error.message : '임대료 자료를 불러오지 못했습니다.',
            });
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [buildingType, districtCode]);

  const payload = state.kind === 'ready' ? state.payload : null;
  // 사용자가 고른 조사 상권이 새 자료에 없으면 자치구 주변 첫 상권, 없으면 서울 전체를 보여 준다.
  const region = useMemo(() => {
    if (!payload) return null;
    const byPath = new Map(payload.regions.map((item) => [item.path, item]));
    return (
      byPath.get(selectedPath) ??
      byPath.get(payload.district?.regionPaths[0] ?? '') ??
      payload.regions.find((item) => item.level === 1) ??
      payload.regions[0] ??
      null
    );
  }, [payload, selectedPath]);

  if (!buildingType) {
    return (
      <section className="picker rent-panel" aria-labelledby="rent-benchmark-title">
        <h2 id="rent-benchmark-title">임대료 참고</h2>
        <p className="picker-note">사업 조건에서 상가 유형을 고르면 한국부동산원 조사 임대료를 보여 드립니다.</p>
      </section>
    );
  }

  return (
    <section className="picker rent-panel" aria-labelledby="rent-benchmark-title">
      <h2 id="rent-benchmark-title">임대료 참고</h2>
      {state.kind === 'loading' || state.kind === 'idle' ? (
        <p className="picker-note" role="status">
          임대료 자료를 불러오고 있습니다.
        </p>
      ) : state.kind === 'unavailable' ? (
        <p className="picker-note" role="status">
          한국부동산원 임대료 자료가 아직 준비되지 않았습니다. 자료가 적재되면 이곳에 표시됩니다.
        </p>
      ) : state.kind === 'error' ? (
        <p className="inline-error" role="alert">
          {state.message}
        </p>
      ) : payload && region ? (
        <RentBenchmarkBody
          payload={payload}
          region={region}
          profile={profile}
          savedMonthlyRent={savedMonthlyRent}
          onSelect={setSelectedPath}
        />
      ) : (
        <p className="picker-note">표시할 조사 지역이 없습니다.</p>
      )}
    </section>
  );
}

function RentBenchmarkBody({
  payload,
  region,
  profile,
  savedMonthlyRent,
  onSelect,
}: Readonly<{
  payload: RentBenchmarkPayload;
  region: RentRegionBenchmark;
  profile: BusinessProfileForm;
  savedMonthlyRent: string | null;
  onSelect: (path: string) => void;
}>) {
  const floorCode = profile.floor ? PROFILE_FLOOR[profile.floor] : null;
  const floorValue = floorCode ? (region.latest.floors.find((item) => item.floor === floorCode) ?? null) : null;
  const area = { value: profile.areaValue, unit: profile.areaUnit };
  const squareMeters = squareMetersLabel(area);
  const monthly = floorValue ? monthlyRentReferenceWon(floorValue.sourceValue, area) : null;
  const nearby = payload.district
    ? payload.regions.filter((item) => payload.district?.regionPaths.includes(item.path))
    : [];
  const groups = payload.regions.filter((item) => item.level <= 2);
  const locals = payload.regions.filter((item) => item.level === 3);
  const groupNames = [...new Set(locals.map((item) => item.groupName ?? ''))];
  const maxFloor = Math.max(
    1,
    ...region.latest.floors.map((item) => (item.rentPerSquareMeterWon ? Number(item.rentPerSquareMeterWon) : 0)),
  );

  const monthlyNote = !floorCode
    ? '사업 조건에서 층을 고르면 계산합니다.'
    : !floorValue || floorValue.sourceValue === null
      ? `이 지역은 ${floorValue?.label ?? '선택한 층'} 조사값이 없습니다.`
      : !squareMeters
        ? '사업 조건에서 면적을 입력하면 계산합니다.'
        : `${floorValue.label} ㎡당 임대료 × ${squareMeters}㎡`;

  return (
    <>
      <p className="picker-note rent-lead">
        {payload.source.statName}의 {payload.buildingType.label} {payload.source.latestQuarterLabel} 조사값입니다. 지역
        평균이며, 재무계획의 월 임대료에 자동으로 넣지 않습니다.
      </p>
      <div className="select-row rent-select-row">
        <label className="field">
          <span>조사 지역</span>
          <select value={region.path} onChange={(event) => onSelect(event.target.value)}>
            {nearby.length > 0 && (
              <optgroup label={`${payload.district?.name ?? ''} 주변 조사 상권`}>
                {nearby.map((item) => (
                  <option key={`near-${item.path}`} value={item.path}>
                    {item.name}
                  </option>
                ))}
              </optgroup>
            )}
            <optgroup label="서울·권역 평균">
              {groups.map((item) => (
                <option key={item.path} value={item.path}>
                  {regionLabel(item)}
                </option>
              ))}
            </optgroup>
            {groupNames.map((groupName) => (
              <optgroup key={groupName} label={`${groupName} 권역 조사 상권`}>
                {locals
                  .filter((item) => item.groupName === groupName)
                  .map((item) => (
                    <option key={item.path} value={item.path}>
                      {item.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <small>
            {payload.district
              ? nearby.length > 0
                ? `${payload.district.name}와 겹치는 조사 상권 ${nearby.length}곳이 위에 있습니다.`
                : `${payload.district.name}와 겹치는 조사 상권이 없어 서울 전체를 보여 드립니다.`
              : '자치구를 고르면 주변 조사 상권을 먼저 보여 드립니다.'}
          </small>
        </label>
      </div>

      <div className="summary-grid rent-summary">
        <div>
          <span>월 임대료 참고값</span>
          <strong>{monthly ? formatWon(monthly) : '계산 불가'}</strong>
          <small>{monthlyNote}</small>
        </div>
        <div>
          <span>{floorValue ? `${floorValue.label} ㎡당 월 임대료` : '선택 층 ㎡당 월 임대료'}</span>
          <strong>
            {floorValue?.rentPerSquareMeterWon ? formatWon(floorValue.rentPerSquareMeterWon) : '자료 없음'}
          </strong>
          <small>{profile.floor === 'UPPER_2_PLUS' ? '2층 이상은 2층 값으로 봅니다.' : regionLabel(region)}</small>
        </div>
        <div>
          <span>대표 ㎡당 월 임대료(1층 기준)</span>
          <strong>
            {region.latest.rentPerSquareMeterWon ? formatWon(region.latest.rentPerSquareMeterWon) : '자료 없음'}
          </strong>
          <small>{regionLabel(region)}</small>
        </div>
        <div>
          <span>공실률</span>
          <strong>{region.latest.vacancyRatePercent ? `${region.latest.vacancyRatePercent}%` : '자료 없음'}</strong>
          <small>{payload.buildingType.label}</small>
        </div>
      </div>

      {savedMonthlyRent !== null && (
        <p className="funding-position">
          이 계획에 저장된 월 임대료: {formatWon(savedMonthlyRent)}. 부동산원 값은 보증금을 월세로 환산해 더한 금액이라
          월세만 적은 값보다 클 수 있습니다.
        </p>
      )}

      <div className="rent-detail-grid">
        <div>
          <h3>층별 ㎡당 월 임대료</h3>
          {region.latest.floors.length === 0 ? (
            <p className="picker-note">층별 조사값이 없습니다.</p>
          ) : (
            <div className="metric-bars">
              {region.latest.floors.map((item) => (
                <div key={item.floor} className={item.floor === floorCode ? 'metric-row selected' : 'metric-row'}>
                  <span>{item.label}</span>
                  <span className="metric-track" aria-hidden="true">
                    <span
                      style={{
                        width: `${item.rentPerSquareMeterWon ? (Number(item.rentPerSquareMeterWon) / maxFloor) * 100 : 0}%`,
                      }}
                    />
                  </span>
                  <span>{item.rentPerSquareMeterWon ? formatWon(item.rentPerSquareMeterWon) : '자료 없음'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <h3>대표 임대료 추이(㎡당)</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">분기</th>
                  <th scope="col">㎡당 월 임대료</th>
                </tr>
              </thead>
              <tbody>
                {region.trend.map((point) => (
                  <tr key={point.quarter}>
                    <td>{point.label}</td>
                    <td>
                      {point.rentPerSquareMeterWon ? (
                        formatWon(point.rentPerSquareMeterWon)
                      ) : (
                        <span className="missing-value">자료 없음</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <details className="rent-source">
        <summary>기준과 출처</summary>
        <ul>
          {[...payload.definitions, ...payload.limitations].map((line) => (
            <li key={line}>{line}</li>
          ))}
          <li>
            면적은 입력한 값을 임대 면적(전용+공용)으로 보고 계산합니다. 1평은 400/121㎡(약 3.3058㎡)로 환산합니다.
          </li>
        </ul>
        <p className="source-link">
          <a href={payload.source.sourceUrl} target="_blank" rel="noreferrer">
            {payload.source.statName}
          </a>{' '}
          · 기준기간 {payload.source.basisPeriodLabel} · 적재{' '}
          {new Date(payload.source.retrievedAt).toLocaleDateString('ko-KR')}
        </p>
      </details>
    </>
  );
}
