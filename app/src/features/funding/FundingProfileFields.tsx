'use client';

import { SEOUL_DISTRICTS } from './districts.ts';
import { USER_TARGET_GROUP_LABELS } from './match-text.ts';
import { MAX_AGE } from './match-profile.ts';
import { USER_TARGET_GROUPS } from './matching.ts';
import { toggleNoTargetGroup, toggleTargetGroup, type FundingProfileForm } from './profile-form.ts';

// 맞춰 보기 입력란(ADR 0009 §4). /funding과 계획 화면이 함께 쓴다. 연결할 데이터가 있는 것만 받는다: 사업자등록 여부와
// 개업 연월, 자치구, 대표자 나이, 대상 한정. 업종·용도는 받지 않는다.
export default function FundingProfileFields({
  form,
  onChange,
  idPrefix,
  districtHint,
}: {
  readonly form: FundingProfileForm;
  readonly onChange: (next: FundingProfileForm) => void;
  // 두 화면이 한 문서에 함께 그려질 일은 없지만, 입력란 id가 겹치지 않게 화면마다 다르게 준다.
  readonly idPrefix: string;
  // 자치구를 비웠을 때 서버가 대신 쓰는 값의 안내(계획 화면의 사업 조건 자치구).
  readonly districtHint?: string | null;
}) {
  const noTarget = form.targetGroups !== null && form.targetGroups.length === 0;
  return (
    <div className="funding-fields">
      <div className="select-row">
        <label className="field">
          <span>1. 사업자등록 여부</span>
          <select
            value={form.businessStatus}
            onChange={(event) =>
              onChange({ ...form, businessStatus: event.target.value as FundingProfileForm['businessStatus'] })
            }
          >
            <option value="">답하지 않음</option>
            <option value="PRE_STARTUP">예비 창업자(사업자등록 전)</option>
            <option value="BUSINESS">사업자(사업자등록 후)</option>
          </select>
          <small>예비 창업자만·사업자만 받는 공고를 가려 봅니다.</small>
        </label>
        {form.businessStatus === 'BUSINESS' && (
          <label className="field">
            <span>개업 연월 (선택)</span>
            <span className="input-wrap">
              {/* 글자 입력란으로 둔다. month·number 입력란은 덜 채웠거나 형식이 틀린 글자를 빈 값으로 넘겨,
                  입력하지 않음으로 바뀐 것을 알릴 수 없다(profile-form.ts가 받은 글자 그대로 검사한다). */}
              <input
                id={`${idPrefix}-opened`}
                className="text-input"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={form.openedYearMonth}
                placeholder="2024-03"
                onChange={(event) => onChange({ ...form, openedYearMonth: event.target.value })}
              />
            </span>
            <small>업력 조건을 맞춰 봅니다. 달까지만 받아, 기준에 걸치는 달이면 확인 필요로 남습니다.</small>
          </label>
        )}
        <label className="field">
          <span>2. 사업장·거주 자치구</span>
          <select
            value={form.districtCode}
            onChange={(event) => onChange({ ...form, districtCode: event.target.value })}
          >
            <option value="">선택하지 않음</option>
            {SEOUL_DISTRICTS.map((district) => (
              <option key={district.code} value={district.code}>
                {district.name}
              </option>
            ))}
          </select>
          <small>{districtHint ?? '지역을 한정한 공고를 서울 자치구로 맞춰 봅니다.'}</small>
        </label>
        <label className="field">
          <span>3. 대표자 나이 (선택)</span>
          <span className="input-wrap">
            <input
              id={`${idPrefix}-age`}
              className="text-input"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              value={form.age}
              placeholder="예: 35"
              onChange={(event) => onChange({ ...form, age: event.target.value })}
            />
          </span>
          <small>만 나이(0~{MAX_AGE})입니다. 청년 한정 공고도 나이로 맞춰 봅니다.</small>
        </label>
      </div>
      <fieldset className="field target-groups">
        <legend>4. 대상 한정 (선택)</legend>
        <div className="checkbox-row">
          {USER_TARGET_GROUPS.map((group) => (
            <label key={group} className="checkbox-field">
              <input
                type="checkbox"
                checked={form.targetGroups?.includes(group) ?? false}
                onChange={(event) =>
                  onChange({ ...form, targetGroups: toggleTargetGroup(form.targetGroups, group, event.target.checked) })
                }
              />
              {USER_TARGET_GROUP_LABELS[group]}
            </label>
          ))}
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={noTarget}
              onChange={(event) =>
                onChange({ ...form, targetGroups: toggleNoTargetGroup(form.targetGroups, event.target.checked) })
              }
            />
            해당 없음
          </label>
        </div>
        <small>
          아무것도 고르지 않으면 답하지 않음으로 두고, 대상을 한정한 공고는 확인 필요로 보여 줍니다. 대상을 고르면
          고르지 않은 대상에는 해당하지 않는 것으로 봅니다. 장애 여부는 민감한 정보라 맞춰 보기에만 쓰고 AI에 보내지
          않으며, 계획을 지우면 함께 지워집니다.
        </small>
      </fieldset>
    </div>
  );
}
