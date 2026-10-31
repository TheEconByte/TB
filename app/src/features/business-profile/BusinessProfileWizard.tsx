'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { SEOUL_DISTRICTS } from '@/features/funding/districts';
import type { BusinessCategoryInfo, BusinessDirectoryReleaseInfo } from '@/features/business-directory/types';
import { BUILDING_TYPE_CRITERIA, BUILDING_TYPE_LABELS, BUILDING_TYPES } from '@/features/rent-benchmark/types';
import {
  EMPTY_BUSINESS_PROFILE_FORM,
  businessProfileMissingFields,
  businessProfileSaveState,
  type BusinessProfileForm,
} from './form';
import { AreaIcon, BuildingTypeIcon, CoffeeIcon, FloorIcon, KoreanFoodIcon, SearchIcon, TipIcon } from './icons';

const STEPS = ['위치·업종', '매장 크기', '매장 층', '상가 유형', '입력 확인'] as const;

const INDUSTRIES = [
  { code: 'CS100001', label: '한식음식점', Icon: KoreanFoodIcon },
  { code: 'CS100010', label: '커피·음료', Icon: CoffeeIcon },
] as const;

const AREA_PRESETS = [
  { value: '12', label: '소형', size: 'small' },
  { value: '24', label: '중형', size: 'medium' },
  { value: '40', label: '대형', size: 'large' },
] as const;

const FLOOR_LABELS: Readonly<Record<Exclude<BusinessProfileForm['floor'], ''>, string>> = {
  BASEMENT_1: '지하 1층',
  GROUND_1: '1층',
  UPPER_2_PLUS: '2층 이상',
};

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
  const saveState = businessProfileSaveState(form);
  const complete = saveState.kind === 'COMPLETE';
  const missing = businessProfileMissingFields(form);
  const district = SEOUL_DISTRICTS.find((item) => item.code === form.districtCode)?.name ?? '미선택';
  const broadName =
    form.marketIndustryCode === 'CS100001'
      ? '한식음식점'
      : form.marketIndustryCode === 'CS100010'
        ? '커피·음료'
        : '미선택';

  return (
    <section className="business-wizard" aria-labelledby="business-wizard-title">
      <div className="wizard-top">
        <div className="wizard-title-row">
          <strong id="business-wizard-title">창업 조건 입력</strong>
          <span>
            {step + 1} / {STEPS.length}
          </span>
        </div>
        <div className="wizard-progress">
          <span style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} />
        </div>
        <ol className="wizard-steps">
          {STEPS.map((label, index) => (
            <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>
              <button
                type="button"
                className="step-button"
                aria-current={index === step ? 'step' : undefined}
                onClick={() => setStep(index)}
              >
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
              title={
                <>
                  <em>어느 지역구</em>에서 <em>어떤 업종</em>으로
                  <br />
                  창업하시는지 알려주세요.
                </>
              }
              note="세부 업종 경쟁과 서울시 상위 업종 매출은 서로 다른 범위로 표시합니다."
            />
            <label className="field search-field">
              <span>지역구</span>
              <span className="search-select">
                <SearchIcon />
                <select
                  value={form.districtCode}
                  onChange={(event) => onChange({ ...form, districtCode: event.target.value })}
                >
                  <option value="">서울시 자치구 선택</option>
                  {SEOUL_DISTRICTS.map((item) => (
                    <option key={item.code} value={item.code}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </span>
            </label>
            <div className="field" role="group" aria-labelledby="industry-group-label">
              <span id="industry-group-label">업종 대분류</span>
              <div className="choice-grid two">
                {INDUSTRIES.map(({ code, label, Icon }) => (
                  <button
                    type="button"
                    key={code}
                    aria-pressed={form.marketIndustryCode === code}
                    className={form.marketIndustryCode === code ? 'choice-card selected' : 'choice-card'}
                    onClick={() => onChange({ ...form, marketIndustryCode: code, detailedIndustryCode: '' })}
                  >
                    <Icon />
                    <strong>{label}</strong>
                  </button>
                ))}
              </div>
            </div>
            {form.marketIndustryCode && (
              <label className="field detail-field">
                <span>업종 소분류</span>
                <select
                  value={form.detailedIndustryCode}
                  disabled={!release}
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
            )}
            {form.marketIndustryCode && <ScopeBanner detail={selectedDetail?.name ?? null} broad={broadName} />}
          </>
        )}
        {step === 1 && (
          <>
            <WizardHeading
              title={
                <>
                  <em>어떤 크기의 매장</em>을
                  <br />
                  생각하시는지 알려주세요.
                </>
              }
              note="카드는 빠른 입력입니다. 지역 평균값을 만들지 않고, 아래에 입력한 정확한 면적을 저장합니다."
            />
            <div className="choice-grid three">
              {AREA_PRESETS.map(({ value, label, size }) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={form.areaValue === value && form.areaUnit === 'PYEONG'}
                  className={
                    form.areaValue === value && form.areaUnit === 'PYEONG' ? 'choice-card selected' : 'choice-card'
                  }
                  onClick={() => onChange({ ...form, areaValue: value, areaUnit: 'PYEONG' })}
                >
                  <AreaIcon size={size} />
                  <strong>{label}</strong>
                  <span>
                    {value}평 · 약 {pyeongToSquareMeters(value)}㎡
                  </span>
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
              title={
                <>
                  <em>매장이 어떤 층</em>에 있는 걸
                  <br />
                  생각하시는지 알려주세요.
                </>
              }
              note="층에 맞는 부동산원 층별 임대료를 참고로 보여 드립니다. 재무계획에는 자동으로 넣지 않습니다."
            />
            <div className="choice-grid three">
              {(Object.entries(FLOOR_LABELS) as Array<[keyof typeof FLOOR_LABELS, string]>).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={form.floor === value}
                  className={form.floor === value ? 'choice-card selected' : 'choice-card'}
                  onClick={() => onChange({ ...form, floor: value })}
                >
                  <FloorIcon floor={value} />
                  <strong>{label}</strong>
                </button>
              ))}
            </div>
          </>
        )}
        {step === 3 && (
          <>
            <WizardHeading
              title={
                <>
                  <em>매장이 어떤 건물</em>에 있는 걸
                  <br />
                  생각하시는지 알려주세요.
                </>
              }
              note="한국부동산원 임대동향조사의 상가 구분입니다. 고른 유형의 조사 임대료를 참고로 보여 드립니다."
            />
            <div className="choice-grid three">
              {BUILDING_TYPES.map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={form.buildingType === value}
                  className={form.buildingType === value ? 'choice-card selected' : 'choice-card'}
                  onClick={() => onChange({ ...form, buildingType: value })}
                >
                  <BuildingTypeIcon type={value} />
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
              title={
                <>
                  <em>입력한 창업 조건</em>을
                  <br />
                  확인해 주세요.
                </>
              }
              note={
                complete
                  ? '화면 아래 "초안 저장"을 누르면 계획과 함께 저장됩니다. 재무 계산 입력과는 분리해 저장합니다.'
                  : saveState.kind === 'EMPTY'
                    ? '사업 조건 없이 재무 계획만 저장할 수 있습니다. 조건을 입력하면 임대료·프랜차이즈 참고 자료를 볼 수 있습니다.'
                    : '일부만 입력한 상태에서는 초안을 저장할 수 없습니다. 빠진 항목을 입력하거나 사업 조건을 모두 비워 주세요.'
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
            {saveState.kind !== 'EMPTY' && (
              <button type="button" className="link-button" onClick={() => onChange(EMPTY_BUSINESS_PROFILE_FORM)}>
                사업 조건 모두 비우기
              </button>
            )}
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

function WizardHeading({ title, note }: Readonly<{ title: ReactNode; note: string }>) {
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
      <strong>
        <TipIcon />
        데이터 범위
      </strong>
      <span>
        경쟁 현황은 <em>{detail ? `${detail} 세부 업종` : '세부 업종 미선택'}</em> 기준이에요.
      </span>
      <span>
        매출·고객 분석은 <em>{broad} 전체</em> 기준이에요.
      </span>
    </div>
  );
}

// 1평 = 400/121㎡. 화면 표시용 근삿값이며 저장값은 사용자가 고른 평 단위 원값이다.
function pyeongToSquareMeters(pyeong: string): string {
  return ((Number(pyeong) * 400) / 121).toFixed(1);
}
