'use client';

import { useEffect, useMemo, useState } from 'react';
import { SEOUL_DISTRICTS } from '@/features/funding/districts';
import type { BusinessCategoryInfo, BusinessDirectoryReleaseInfo } from '@/features/business-directory/types';
import { OPEN_INDUSTRIES, industryByCode } from '@/features/industries';
import { BUILDING_TYPE_CRITERIA, BUILDING_TYPE_LABELS, BUILDING_TYPES } from '@/features/rent-benchmark/types';
import {
  EMPTY_BUSINESS_PROFILE_FORM,
  businessProfileMissingFields,
  businessProfileSaveState,
  selectMarketIndustry,
  type BusinessProfileForm,
} from './form';
import { AreaIcon, BuildingTypeIcon, FloorIcon, SearchIcon, TipIcon } from './icons';

const STEPS = ['위치·업종', '매장 크기', '매장 층', '상가 유형', '입력 확인'] as const;

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
  const [categoryMessage, setCategoryMessage] = useState('세부 업종 목록을 불러오는 중…');

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
        setCategoryMessage(data.nullReason ?? '소상공인시장진흥공단 점포 자료 기준');
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
  const broadName = industryByCode(form.marketIndustryCode)?.shortName ?? '미선택';

  return (
    <section className="business-wizard" aria-labelledby="business-wizard-title">
      <div className="wizard-top">
        <div className="wizard-title-row">
          <strong id="business-wizard-title">사업 조건</strong>
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
            <WizardHeading title="자치구와 업종" />
            <label className="field search-field">
              <span>자치구</span>
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
            <label className="field">
              <span>업종 대분류</span>
              <select
                value={form.marketIndustryCode}
                onChange={(event) => onChange(selectMarketIndustry(form, event.target.value))}
              >
                <option value="">업종을 선택하세요</option>
                {OPEN_INDUSTRIES.map(({ code, shortName }) => (
                  <option key={code} value={code}>
                    {shortName}
                  </option>
                ))}
              </select>
            </label>
            {form.marketIndustryCode && (
              <label className="field detail-field">
                <span>업종 소분류</span>
                <select
                  value={form.detailedIndustryCode}
                  disabled={!release}
                  onChange={(event) => onChange({ ...form, detailedIndustryCode: event.target.value })}
                >
                  <option value="">{!release ? '세부 업종 자료 없음' : '선택하지 않음'}</option>
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
            <WizardHeading title="매장 면적" />
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
            <WizardHeading title="매장 층" />
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
            <WizardHeading title="상가 유형" />
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
              title="입력 확인"
              note={
                complete
                  ? '[초안 저장]을 누르면 계획과 함께 저장됩니다.'
                  : saveState.kind === 'EMPTY'
                    ? '모두 비워 두고 재무 계획만 저장해도 됩니다.'
                    : '일부만 채우면 저장되지 않습니다. 다 채우거나 모두 비우세요.'
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
                  {form.areaValue ? `${form.areaValue}${form.areaUnit === 'PYEONG' ? '평' : '㎡'}` : '미입력'}
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
                <span>빠진 항목</span>
                <strong>
                  {complete
                    ? '없음'
                    : missing.length > 0
                      ? missing.map((field) => field.label).join(', ')
                      : '필수 항목'}
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

function WizardHeading({ title, note }: Readonly<{ title: string; note?: string }>) {
  return (
    <div className="wizard-heading">
      <h2 id="business-profile-title">{title}</h2>
      {note && <p>{note}</p>}
    </div>
  );
}

function ScopeBanner({ detail, broad }: Readonly<{ detail: string | null; broad: string }>) {
  return (
    <div className="scope-banner">
      <strong>
        <TipIcon />
        집계 범위
      </strong>
      <span>
        경쟁 점포는 <em>{detail ? `${detail} 세부 업종` : '세부 업종 미선택'}</em> 기준입니다.
      </span>
      <span>
        매출·고객은 <em>{broad} 전체</em> 기준입니다.
      </span>
    </div>
  );
}

// 1평 = 400/121㎡. 화면 표시용 근삿값이며 저장값은 사용자가 고른 평 단위 원값이다.
function pyeongToSquareMeters(pyeong: string): string {
  return ((Number(pyeong) * 400) / 121).toFixed(1);
}
