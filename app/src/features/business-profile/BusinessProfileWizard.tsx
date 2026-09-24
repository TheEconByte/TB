'use client';

import { useEffect, useMemo, useState } from 'react';
import { SEOUL_DISTRICTS } from '@/features/funding/districts';
import type { BusinessCategoryInfo, BusinessDirectoryReleaseInfo } from '@/features/business-directory/types';
import { BUILDING_TYPE_CRITERIA, BUILDING_TYPE_LABELS, BUILDING_TYPES } from '@/features/rent-benchmark/types';
import type { BusinessProfileInput } from './schema';

export type BusinessProfileForm = {
  districtCode: string;
  marketIndustryCode: '' | 'CS100001' | 'CS100010';
  detailedIndustryCode: string;
  areaValue: string;
  areaUnit: 'PYEONG' | 'SQUARE_METERS';
  floor: '' | 'BASEMENT_1' | 'GROUND_1' | 'UPPER_2_PLUS';
  buildingType: '' | 'SMALL_RETAIL' | 'MEDIUM_LARGE_RETAIL' | 'COLLECTIVE_RETAIL';
};

export const EMPTY_BUSINESS_PROFILE_FORM: BusinessProfileForm = {
  districtCode: '',
  marketIndustryCode: '',
  detailedIndustryCode: '',
  areaValue: '',
  areaUnit: 'PYEONG',
  floor: '',
  buildingType: '',
};

export function businessProfilePayload(form: BusinessProfileForm): BusinessProfileInput | null {
  if (
    !form.districtCode ||
    !form.marketIndustryCode ||
    !/^\d+(?:\.\d{1,2})?$/.test(form.areaValue) ||
    !form.floor ||
    !form.buildingType
  )
    return null;
  return {
    districtCode: form.districtCode,
    marketIndustryCode: form.marketIndustryCode,
    detailedIndustryCode: form.detailedIndustryCode || null,
    area: { value: form.areaValue, unit: form.areaUnit },
    floor: form.floor,
    buildingType: form.buildingType,
  };
}

export function businessProfileFormFromStored(value: unknown): BusinessProfileForm {
  if (!value || typeof value !== 'object') return EMPTY_BUSINESS_PROFILE_FORM;
  const stored = value as Record<string, unknown>;
  const area = stored.area && typeof stored.area === 'object' ? (stored.area as Record<string, unknown>) : {};
  return {
    districtCode: typeof stored.districtCode === 'string' ? stored.districtCode : '',
    marketIndustryCode:
      stored.marketIndustryCode === 'CS100001' || stored.marketIndustryCode === 'CS100010'
        ? stored.marketIndustryCode
        : '',
    detailedIndustryCode: typeof stored.detailedIndustryCode === 'string' ? stored.detailedIndustryCode : '',
    areaValue: typeof area.value === 'string' ? area.value : '',
    areaUnit: area.unit === 'SQUARE_METERS' ? 'SQUARE_METERS' : 'PYEONG',
    floor:
      stored.floor === 'BASEMENT_1' || stored.floor === 'GROUND_1' || stored.floor === 'UPPER_2_PLUS'
        ? stored.floor
        : '',
    buildingType:
      stored.buildingType === 'SMALL_RETAIL' ||
      stored.buildingType === 'MEDIUM_LARGE_RETAIL' ||
      stored.buildingType === 'COLLECTIVE_RETAIL'
        ? stored.buildingType
        : '',
  };
}

const STEPS = ['위치·업종', '매장 크기', '매장 층', '상가 유형', '입력 확인'] as const;

const FLOOR_LABELS: Readonly<Record<Exclude<BusinessProfileForm['floor'], ''>, string>> = {
  BASEMENT_1: '지하 1층',
  GROUND_1: '1층',
  UPPER_2_PLUS: '2층 이상',
};

// 입력 확인 단계에서 빠진 항목과 그 항목을 입력하는 단계를 알려 준다. 필수값이 하나라도
// 빠지면 초안을 저장해도 사업 조건은 저장되지 않는다(businessProfilePayload가 null).
function missingFields(form: BusinessProfileForm): Array<{ label: string; step: number }> {
  return [
    { label: '지역구', step: 0, missing: !form.districtCode },
    { label: '업종', step: 0, missing: !form.marketIndustryCode },
    { label: '면적', step: 1, missing: !/^\d+(?:\.\d{1,2})?$/.test(form.areaValue) },
    { label: '층', step: 2, missing: !form.floor },
    { label: '상가 유형', step: 3, missing: !form.buildingType },
  ].filter((field) => field.missing);
}

export default function BusinessProfileWizard({
  form,
  onChange,
  onFinish,
}: Readonly<{ form: BusinessProfileForm; onChange: (form: BusinessProfileForm) => void; onFinish?: () => void }>) {
  const [step, setStep] = useState(0);
  const [categories, setCategories] = useState<BusinessCategoryInfo[]>([]);
  const [release, setRelease] = useState<BusinessDirectoryReleaseInfo | null>(null);
  const [categoryMessage, setCategoryMessage] = useState('세부 업종 스냅샷을 확인하고 있습니다.');

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/business-categories', { headers: { accept: 'application/json' } })
      .then(async (response) => {
        if (!response.ok) throw new Error('세부 업종 목록을 불러오지 못했습니다.');
        return response.json() as Promise<{
          activeRelease: BusinessDirectoryReleaseInfo | null;
          categories: BusinessCategoryInfo[];
          nullReason: string | null;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        setCategories(data.categories);
        setRelease(data.activeRelease);
        setCategoryMessage(data.nullReason ?? `소진공 스냅샷 ${data.activeRelease?.releaseKey ?? ''}`);
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setCategoryMessage(error instanceof Error ? error.message : '세부 업종 자료를 확인하지 못했습니다.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredCategories = useMemo(
    () => categories.filter((category) => category.marketIndustryCode === form.marketIndustryCode),
    [categories, form.marketIndustryCode],
  );
  const selectedDetail = categories.find((category) => category.code === form.detailedIndustryCode) ?? null;
  const complete = businessProfilePayload(form) !== null;
  const missing = missingFields(form);
  const district = SEOUL_DISTRICTS.find((item) => item.code === form.districtCode)?.name ?? '미선택';
  const broadName =
    form.marketIndustryCode === 'CS100001'
      ? '한식음식점'
      : form.marketIndustryCode === 'CS100010'
        ? '커피·음료'
        : '미선택';

  return (
    <section className="business-wizard" aria-labelledby="business-profile-title">
      <div className="wizard-sidebar">
        <p>
          진행률{' '}
          <strong>
            {step + 1} / {STEPS.length}
          </strong>
        </p>
        <div className="wizard-progress">
          <span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
        <ol>
          {STEPS.map((label, index) => (
            <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>
              <button type="button" onClick={() => setStep(index)}>
                <span>{index < step ? '✓' : index + 1}</span>
                {label}
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="wizard-panel">
        {step === 0 && (
          <>
            <WizardHeading
              title="어디에서 어떤 가게를 열 계획인지 알려주세요."
              note="세부 업종 경쟁과 서울시 상위 업종 매출은 서로 다른 범위로 표시합니다."
            />
            <div className="field-grid">
              <label className="field">
                <span>지역구</span>
                <select
                  value={form.districtCode}
                  onChange={(event) => onChange({ ...form, districtCode: event.target.value })}
                >
                  <option value="">자치구를 선택하세요</option>
                  {SEOUL_DISTRICTS.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>업종 대분류</span>
                <select
                  value={form.marketIndustryCode}
                  onChange={(event) =>
                    onChange({
                      ...form,
                      marketIndustryCode: event.target.value as BusinessProfileForm['marketIndustryCode'],
                      detailedIndustryCode: '',
                    })
                  }
                >
                  <option value="">업종을 선택하세요</option>
                  <option value="CS100001">한식음식점</option>
                  <option value="CS100010">커피·음료</option>
                </select>
              </label>
              <label className="field">
                <span>업종 소분류</span>
                <select
                  value={form.detailedIndustryCode}
                  disabled={!release || !form.marketIndustryCode}
                  onChange={(event) => onChange({ ...form, detailedIndustryCode: event.target.value })}
                >
                  <option value="">{!release ? '소진공 스냅샷 적재 전' : '선택하지 않음'}</option>
                  {filteredCategories.map((category) => (
                    <option key={category.code} value={category.code}>
                      {category.name}
                    </option>
                  ))}
                </select>
                <small>{categoryMessage}</small>
              </label>
            </div>
            {form.marketIndustryCode && <ScopeBanner detail={selectedDetail?.name ?? null} broad={broadName} />}
          </>
        )}
        {step === 1 && (
          <>
            <WizardHeading
              title="매장 크기를 알려주세요."
              note="지역 평균값을 만들지 않고 사용자가 계획한 정확한 면적을 저장합니다."
            />
            <div className="choice-grid three">
              {[
                ['12', '소형'],
                ['24', '중형'],
                ['40', '대형'],
              ].map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={
                    form.areaValue === value && form.areaUnit === 'PYEONG' ? 'choice-card selected' : 'choice-card'
                  }
                  onClick={() => onChange({ ...form, areaValue: value, areaUnit: 'PYEONG' })}
                >
                  <strong>{label}</strong>
                  <span>{value}평 빠른 입력</span>
                </button>
              ))}
            </div>
            <div className="inline-fields">
              <label className="field">
                <span>정확한 면적</span>
                <span className="input-wrap">
                  <input
                    value={form.areaValue}
                    inputMode="decimal"
                    onChange={(event) => onChange({ ...form, areaValue: event.target.value })}
                  />
                  <b>{form.areaUnit === 'PYEONG' ? '평' : '㎡'}</b>
                </span>
              </label>
              <label className="field">
                <span>단위</span>
                <select
                  value={form.areaUnit}
                  onChange={(event) =>
                    onChange({ ...form, areaUnit: event.target.value as BusinessProfileForm['areaUnit'] })
                  }
                >
                  <option value="PYEONG">평</option>
                  <option value="SQUARE_METERS">㎡</option>
                </select>
              </label>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <WizardHeading
              title="매장이 어느 층에 있는지 알려주세요."
              note="층에 맞는 부동산원 층별 임대료를 참고로 보여 드립니다. 재무계획에는 자동으로 넣지 않습니다."
            />
            <div className="choice-grid three">
              {(Object.entries(FLOOR_LABELS) as Array<[keyof typeof FLOOR_LABELS, string]>).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  className={form.floor === value ? 'choice-card selected' : 'choice-card'}
                  onClick={() => onChange({ ...form, floor: value })}
                >
                  <span className="floor-icon">{value === 'BASEMENT_1' ? '▤' : value === 'GROUND_1' ? '▥' : '▦'}</span>
                  <strong>{label}</strong>
                </button>
              ))}
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <WizardHeading
              title="매장이 어떤 건물에 있는지 알려주세요."
              note="한국부동산원 임대동향조사의 상가 구분입니다. 고른 유형의 조사 임대료를 참고로 보여 드립니다."
            />
            <div className="choice-grid three">
              {BUILDING_TYPES.map((value) => (
                <button
                  type="button"
                  key={value}
                  className={form.buildingType === value ? 'choice-card selected' : 'choice-card'}
                  onClick={() => onChange({ ...form, buildingType: value })}
                >
                  <strong>{BUILDING_TYPE_LABELS[value]}</strong>
                  <span>{BUILDING_TYPE_CRITERIA[value]}</span>
                </button>
              ))}
            </div>
          </>
        )}
        {step === 4 && (
          <>
            <WizardHeading
              title="입력 범위를 확인해 주세요."
              note={
                complete
                  ? '화면 아래 "초안 저장"을 누르면 계획과 함께 저장됩니다. 재무 계산 입력과는 분리해 저장합니다.'
                  : '필수값이 모두 있어야 사업 조건이 저장됩니다. 빠진 항목을 먼저 입력해 주세요.'
              }
            />
            <div className="profile-summary-grid">
              <div>
                <span>지역</span>
                <strong>{district}</strong>
              </div>
              <div>
                <span>업종</span>
                <strong>{selectedDetail?.name ?? broadName}</strong>
              </div>
              <div>
                <span>면적</span>
                <strong>
                  {form.areaValue || '미입력'} {form.areaValue ? (form.areaUnit === 'PYEONG' ? '평' : '㎡') : ''}
                </strong>
              </div>
              <div>
                <span>층</span>
                <strong>{form.floor ? FLOOR_LABELS[form.floor] : '미선택'}</strong>
              </div>
              <div>
                <span>상가 유형</span>
                <strong>{form.buildingType ? BUILDING_TYPE_LABELS[form.buildingType] : '미선택'}</strong>
              </div>
              <div>
                <span>입력 상태</span>
                <strong>
                  {complete
                    ? '저장 가능'
                    : missing.length > 0
                      ? `빠진 항목: ${missing.map((field) => field.label).join(', ')}`
                      : '필수값 미입력'}
                </strong>
              </div>
            </div>
            <ScopeBanner detail={selectedDetail?.name ?? null} broad={broadName} />
          </>
        )}
        <div className="wizard-nav">
          <button
            type="button"
            className="secondary-button"
            disabled={step === 0}
            onClick={() => setStep((value) => Math.max(0, value - 1))}
          >
            이전
          </button>
          {/* 마지막 단계에는 다음 단계가 없으므로, 빠진 항목으로 돌아가거나 아래 참고 자료로 넘어가게 한다. */}
          {step < STEPS.length - 1 ? (
            <button type="button" onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}>
              다음
            </button>
          ) : missing.length > 0 ? (
            <button type="button" onClick={() => setStep(missing[0].step)}>
              빠진 항목 입력
            </button>
          ) : (
            <button type="button" disabled={!onFinish} onClick={() => onFinish?.()}>
              다음: 참고 자료
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function WizardHeading({ title, note }: Readonly<{ title: string; note: string }>) {
  return (
    <div className="wizard-heading">
      <h2 id="business-profile-title">{title}</h2>
      <p>{note}</p>
    </div>
  );
}

function ScopeBanner({ detail, broad }: Readonly<{ detail: string | null; broad: string }>) {
  return (
    <div className="scope-banner">
      <strong>데이터 범위</strong>
      <span>경쟁 현황: {detail ? `${detail} 세부 업종 기준` : '세부 업종 미선택'}</span>
      <span>매출·고객 분석: {broad} 전체 기준</span>
    </div>
  );
}
