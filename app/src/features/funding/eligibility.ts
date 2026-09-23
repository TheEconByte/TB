import type { FundingCatalog, FundingProduct } from './schema.ts';
import {
  REPAYABLE_SUPPORT_TYPES,
  combineVerdicts,
  INDUSTRY_CODE_PATTERN,
  isPrimaryRetrievalMethod,
  isSupportedRepaymentMethod,
  REQUIRED_EVIDENCE_SUBJECTS,
  reviewState,
  type BusinessStage,
  type EvidenceSubject,
  type ObservedApplicationStatus,
  type Purpose,
  type ReviewState,
  type SupportType,
  type Verdict,
} from './types.ts';

// What the user (or a plan) declares today. The user-facing matching API is a
// later F4 step; this task only fixes the structure and the rules.
export type FundingProfile = {
  businessStage: BusinessStage | 'UNKNOWN';
  districtCode: string | null;
  industryCode: string | null;
  purpose: Purpose | 'UNKNOWN';
};

export const UNKNOWN_FUNDING_PROFILE: FundingProfile = {
  businessStage: 'UNKNOWN',
  districtCode: null,
  industryCode: null,
  purpose: 'UNKNOWN',
};

export type FundingConditionKey = 'BUSINESS_STAGE' | 'REGION' | 'PURPOSE' | 'INDUSTRY';

export type FundingConditionResult = {
  key: FundingConditionKey;
  label: string;
  verdict: Verdict;
  detail: string;
  evidenceIds: string[];
};

export type ProductAudience = 'PRE_REGISTRATION_ELIGIBLE' | 'POST_REGISTRATION_ONLY' | 'UNKNOWN';

export type FundingCandidateStatus =
  'CURRENT_CANDIDATE' | 'NEEDS_CONFIRMATION' | 'NOT_ELIGIBLE' | 'POST_REGISTRATION' | 'CLOSED' | 'REVIEW_OVERDUE';

export type ProductRepaymentAvailability = {
  // 상품 조건만으로 상환액을 계산할 수 있는 구조인지. 지원금·공간·프로그램과
  // 금리 미확정 상품은 항상 false다.
  supported: boolean;
  // 공개된 최대 한도다. 실제 신청·승인액이나 사용자의 시뮬레이션 원금이 아니다.
  publicLimitKrw: string | null;
  // 상품에서 확인한 금리·기간·상환방식. 사용자가 저장한 대출금과 결합하기 전의
  // 조건이며 지원 대상이 아니면 null이다.
  terms: ProductLoanTerms | null;
  reasons: string[];
  note: string;
};

// 상품 확정 조건에서 그대로 옮길 수 있는 값만 담는다. 계산은 F1 엔진이 하고,
// 여기서는 계획의 신규 대출 입력으로 바꿀 값만 정한다.
export type ProductLoanTerms = {
  annualInterestRatePercent: string;
  totalMonths: number;
  graceMonths: number;
  repaymentMethod: 'EQUAL_INSTALLMENT' | 'EQUAL_PRINCIPAL';
};

export type FundingCandidateEvaluation = {
  productKey: string;
  version: string;
  name: string;
  organization: string;
  supportType: SupportType;
  observedApplicationStatus: ObservedApplicationStatus;
  observedAt: string;
  reviewedAt: string | null;
  nextReviewAt: string | null;
  officialUrl: string;
  reviewState: ReviewState;
  audience: ProductAudience;
  // 공식 원문 페이지·첨부를 직접 확인한 근거가 있는지. 검색 결과 요약만 있으면
  // false이고 현재 후보로 확정하지 않는다.
  primaryEvidenceVerified: boolean;
  conditions: FundingConditionResult[];
  eligibilityVerdict: Verdict;
  candidateStatus: FundingCandidateStatus;
  candidateReason: string;
  manualChecks: string[];
  unsupportedCalculationReasons: string[];
  repayment: ProductRepaymentAvailability;
};

export type FundingCandidateSummary = Record<FundingCandidateStatus, number> & { total: number };

export type FundingCandidateList = {
  asOfDate: string;
  basisDate: string;
  catalogKey: string;
  catalogVersion: string;
  profile: FundingProfile;
  evaluations: FundingCandidateEvaluation[];
  summary: FundingCandidateSummary;
};

const STAGE_LABELS: Record<BusinessStage, string> = {
  PRE_REGISTRATION: '사업자등록 전(예비 창업자)',
  POST_REGISTRATION: '사업자등록 이후',
};

const PURPOSE_LABELS: Record<Purpose, string> = {
  STARTUP_COST: '창업 준비 비용',
  FACILITY_EQUIPMENT: '시설·장비',
  OPERATING_FUNDS: '운전자금',
  MARKETING: '마케팅',
  SPACE_RENT: '공간·임차료',
  PROGRAM_TRAINING: '보육·교육',
  RND: '기술개발',
  OTHER: '기타',
};

export function purposeLabel(purpose: Purpose): string {
  return PURPOSE_LABELS[purpose];
}

export function stageLabel(stage: BusinessStage): string {
  return STAGE_LABELS[stage];
}

// 저장하거나 조회하기 전에 화면에서 확인하는 업종 코드 형식. 형식이 틀린 값은 서버가
// 계획 저장 전체를 400으로 거부하므로, 두 화면이 같은 문장으로 먼저 막는다.
export function industryCodeIssue(input: string): string | null {
  const code = input.trim().toUpperCase();
  if (code === '' || INDUSTRY_CODE_PATTERN.test(code)) return null;
  return '업종 코드는 CS100001 형식이어야 합니다. 비워두면 업종 조건은 미확인으로 남습니다.';
}

function evidenceIdsFor(product: FundingProduct, subject: EvidenceSubject): string[] {
  return product.evidence.filter((entry) => entry.subject === subject).map((entry) => entry.id);
}

function hasPrimaryEvidenceFor(product: FundingProduct, subject: EvidenceSubject): boolean {
  return product.evidence.some((entry) => entry.subject === subject && isPrimaryRetrievalMethod(entry.retrievalMethod));
}

function unverifiedCondition(
  product: FundingProduct,
  subject: EvidenceSubject,
  base: Pick<FundingConditionResult, 'key' | 'label' | 'evidenceIds'>,
): FundingConditionResult | null {
  if (hasPrimaryEvidenceFor(product, subject)) return null;
  return {
    ...base,
    verdict: 'UNKNOWN',
    detail: `${subject} 조건을 뒷받침하는 공식 원문 근거가 없어 판정하지 않았습니다.`,
  };
}

function stageCondition(product: FundingProduct, profile: FundingProfile): FundingConditionResult {
  const base = {
    key: 'BUSINESS_STAGE' as const,
    label: '사업 단계',
    evidenceIds: evidenceIdsFor(product, 'BUSINESS_STAGE'),
  };
  if (profile.businessStage === 'UNKNOWN') {
    return { ...base, verdict: 'UNKNOWN', detail: '사업 단계가 입력되지 않아 대상 여부를 판정하지 않았습니다.' };
  }
  const unverified = unverifiedCondition(product, 'BUSINESS_STAGE', base);
  if (unverified) return unverified;
  const stages = product.eligibleBusinessStages.map((stage) => STAGE_LABELS[stage]).join(', ');
  if (product.eligibleBusinessStages.includes(profile.businessStage)) {
    return {
      ...base,
      verdict: 'PASS',
      detail: `${STAGE_LABELS[profile.businessStage]} 단계가 신청 대상에 포함됩니다.`,
    };
  }
  return { ...base, verdict: 'FAIL', detail: `이 상품은 ${stages} 단계만 신청 대상입니다.` };
}

function regionCondition(product: FundingProduct, profile: FundingProfile): FundingConditionResult {
  const base = { key: 'REGION' as const, label: '지역', evidenceIds: evidenceIdsFor(product, 'REGION') };
  const { region } = product;
  if (region.scope !== 'UNKNOWN') {
    const unverified = unverifiedCondition(product, 'REGION', base);
    if (unverified) return unverified;
  }
  switch (region.scope) {
    case 'NATIONWIDE':
      return { ...base, verdict: 'PASS', detail: '전국 대상으로 확인했습니다.' };
    case 'SEOUL':
      return profile.districtCode === null
        ? { ...base, verdict: 'UNKNOWN', detail: '거주·사업장 자치구가 입력되지 않았습니다.' }
        : {
            ...base,
            verdict: 'PASS',
            detail: `서울 지역 대상입니다. 입력한 자치구 ${profile.districtCode} 기준으로 추가 확인이 필요합니다.`,
          };
    case 'DISTRICTS':
      if (profile.districtCode === null) {
        return { ...base, verdict: 'UNKNOWN', detail: '거주·사업장 자치구가 입력되지 않았습니다.' };
      }
      return region.districtCodes.includes(profile.districtCode)
        ? { ...base, verdict: 'PASS', detail: `${region.districtCodes.join(', ')} 지역이 대상에 포함됩니다.` }
        : { ...base, verdict: 'FAIL', detail: `이 상품은 ${region.districtCodes.join(', ')} 지역만 대상입니다.` };
    case 'UNKNOWN':
      return { ...base, verdict: 'UNKNOWN', detail: region.note ?? '원문에서 지역 조건을 확인하지 못했습니다.' };
  }
}

function purposeCondition(product: FundingProduct, profile: FundingProfile): FundingConditionResult {
  const base = { key: 'PURPOSE' as const, label: '용도', evidenceIds: evidenceIdsFor(product, 'PURPOSE') };
  const { purpose } = product;
  if (profile.purpose === 'UNKNOWN') {
    return { ...base, verdict: 'UNKNOWN', detail: '사업 용도가 입력되지 않았습니다.' };
  }
  if (purpose.included.length > 0 || purpose.excluded.length > 0) {
    const unverified = unverifiedCondition(product, 'PURPOSE', base);
    if (unverified) return unverified;
  }
  if (purpose.excluded.includes(profile.purpose)) {
    return { ...base, verdict: 'FAIL', detail: `용도 ${purposeLabel(profile.purpose)}은(는) 제외 대상입니다.` };
  }
  if (purpose.included.length === 0) {
    return { ...base, verdict: 'UNKNOWN', detail: purpose.note ?? '원문에서 지원 용도를 확인하지 못했습니다.' };
  }
  return purpose.included.includes(profile.purpose)
    ? { ...base, verdict: 'PASS', detail: `지원 용도에 ${purposeLabel(profile.purpose)}이(가) 포함됩니다.` }
    : {
        ...base,
        verdict: 'FAIL',
        detail: `지원 용도는 ${purpose.included.map((item) => purposeLabel(item)).join(', ')}입니다.`,
      };
}

function industryCondition(product: FundingProduct, profile: FundingProfile): FundingConditionResult {
  const base = { key: 'INDUSTRY' as const, label: '업종', evidenceIds: evidenceIdsFor(product, 'INDUSTRY') };
  const conditions = product.industryConditions;
  if (conditions.scope !== 'UNKNOWN') {
    const unverified = unverifiedCondition(product, 'INDUSTRY', base);
    if (unverified) return unverified;
  }
  if (conditions.scope === 'UNRESTRICTED') {
    return { ...base, verdict: 'PASS', detail: '업종 제한이 없다고 확인했습니다.' };
  }
  if (profile.industryCode === null) {
    return { ...base, verdict: 'UNKNOWN', detail: '업종 코드가 입력되지 않았습니다.' };
  }
  if (conditions.excluded.includes(profile.industryCode)) {
    return { ...base, verdict: 'FAIL', detail: `업종 ${profile.industryCode}은(는) 제외 대상입니다.` };
  }
  if (conditions.scope === 'UNKNOWN') {
    return { ...base, verdict: 'UNKNOWN', detail: conditions.note ?? '지원 업종 매핑이 검수되지 않았습니다.' };
  }
  if (conditions.included.length === 0) {
    return {
      ...base,
      verdict: 'UNKNOWN',
      detail: conditions.note ?? '제외 업종만 확인되어 포함 업종을 알 수 없습니다.',
    };
  }
  return conditions.included.includes(profile.industryCode)
    ? { ...base, verdict: 'PASS', detail: `업종 ${profile.industryCode}이(가) 지원 업종에 포함됩니다.` }
    : { ...base, verdict: 'FAIL', detail: `지원 업종은 ${conditions.included.join(', ')}입니다.` };
}

export function assessProductRepayment(product: FundingProduct): ProductRepaymentAvailability {
  const reasons = [...product.unsupportedCalculationReasons];
  if (!REPAYABLE_SUPPORT_TYPES.includes(product.supportType)) {
    if (reasons.length === 0) {
      reasons.push(`지원 유형 ${product.supportType}은(는) 대출 원금·상환 일정으로 변환하지 않습니다.`);
    }
    return {
      supported: false,
      publicLimitKrw: null,
      terms: null,
      reasons: [...new Set(reasons)],
      note: '지원금·보증·공간·프로그램 지원은 조달액으로 자동 반영하지 않으며 상환 계산 대상이 아닙니다.',
    };
  }
  if (product.publicLimit === null) reasons.push('공개 한도가 확인되지 않았습니다.');
  if (!product.interestRateConfirmed || product.interestRatePercent === null)
    reasons.push('금리가 확정되지 않았습니다.');
  if (!isSupportedRepaymentMethod(product.repaymentMethod)) {
    reasons.push(`상환방식 ${product.repaymentMethod}은(는) 현재 계산 엔진이 지원하지 않습니다.`);
  }
  if (product.repaymentTermMonths === null || product.repaymentGraceMonths === null) {
    reasons.push('상환기간·거치 조건이 확인되지 않았습니다.');
  } else if (product.repaymentGraceMonths >= product.repaymentTermMonths) {
    reasons.push('거치개월이 전체 상환개월보다 길거나 같습니다.');
  }
  const unique = [...new Set(reasons)];
  const supported = unique.length === 0;
  return {
    supported,
    publicLimitKrw: supported ? product.publicLimit : null,
    terms: supported
      ? {
          annualInterestRatePercent: product.interestRatePercent!,
          totalMonths: product.repaymentTermMonths!,
          graceMonths: product.repaymentGraceMonths!,
          repaymentMethod: product.repaymentMethod as ProductLoanTerms['repaymentMethod'],
        }
      : null,
    reasons: unique,
    note: supported
      ? '상품 확정 조건으로 상환 부담을 계산할 수 있는 구조입니다. 실제 승인·적용 금리는 심사로 결정됩니다.'
      : '금리·기간·상환방식이 확정되지 않아 상품 조건 기반 상환액을 표시하지 않습니다.',
  };
}

export function productAudience(product: FundingProduct): ProductAudience {
  if (product.eligibleBusinessStages.includes('PRE_REGISTRATION')) return 'PRE_REGISTRATION_ELIGIBLE';
  if (product.eligibleBusinessStages.includes('POST_REGISTRATION')) return 'POST_REGISTRATION_ONLY';
  return 'UNKNOWN';
}

export function hasPrimaryEvidence(product: FundingProduct): boolean {
  const subjects: EvidenceSubject[] = [...REQUIRED_EVIDENCE_SUBJECTS];
  if (product.supportType === 'LOAN' || product.supportType === 'GUARANTEE') subjects.push('FINANCIAL_CONDITION');
  return subjects.every((subject) =>
    product.evidence.some((entry) => entry.subject === subject && isPrimaryRetrievalMethod(entry.retrievalMethod)),
  );
}

export function evaluateProduct(
  product: FundingProduct,
  profile: FundingProfile,
  options: { asOfDate: string },
): FundingCandidateEvaluation {
  const conditions = [
    stageCondition(product, profile),
    regionCondition(product, profile),
    purposeCondition(product, profile),
    industryCondition(product, profile),
  ];
  const eligibilityVerdict = combineVerdicts(conditions.map((condition) => condition.verdict));
  const audience = productAudience(product);
  const state = reviewState(product, options.asOfDate);
  const repayment = assessProductRepayment(product);
  const primaryEvidenceVerified = hasPrimaryEvidence(product);

  let candidateStatus: FundingCandidateStatus;
  let candidateReason: string;
  if (state === 'REVIEW_OVERDUE') {
    candidateStatus = 'REVIEW_OVERDUE';
    candidateReason = `다음 검토일 ${product.nextReviewAt ?? '없음'}이(가) 기준일 ${options.asOfDate} 이전이라 재확인 전에는 현재 후보로 표시하지 않습니다.`;
  } else if (product.observedApplicationStatus === 'CLOSED') {
    candidateStatus = 'CLOSED';
    candidateReason = `${product.observedAt} 기준 접수 상태가 CLOSED입니다.`;
  } else if (state === 'UNREVIEWED') {
    candidateStatus = 'NEEDS_CONFIRMATION';
    candidateReason =
      '검수자가 지정되지 않아 운영 검수가 완료되지 않았습니다. 검수 전에는 현재 후보로 표시하지 않습니다.';
  } else if (audience === 'POST_REGISTRATION_ONLY' && profile.businessStage !== 'POST_REGISTRATION') {
    candidateStatus = 'POST_REGISTRATION';
    candidateReason = '예비 창업자가 아니라 사업자등록 이후에만 검토할 수 있는 상품입니다.';
  } else if (eligibilityVerdict === 'FAIL') {
    candidateStatus = 'NOT_ELIGIBLE';
    candidateReason =
      conditions.find((condition) => condition.verdict === 'FAIL')?.detail ?? '명확한 미충족 조건이 있습니다.';
  } else if (!primaryEvidenceVerified) {
    candidateStatus = 'NEEDS_CONFIRMATION';
    candidateReason =
      '검색 결과 요약으로만 확인되어 공식 원문 페이지·첨부를 직접 확인한 근거가 없습니다. 재검수 전에는 현재 후보로 확정하지 않습니다.';
  } else if (eligibilityVerdict === 'UNKNOWN') {
    candidateStatus = 'NEEDS_CONFIRMATION';
    candidateReason =
      conditions.find((condition) => condition.verdict === 'UNKNOWN')?.detail ?? '확인되지 않은 조건이 있습니다.';
  } else if (product.observedApplicationStatus === 'OPEN') {
    candidateStatus = 'CURRENT_CANDIDATE';
    candidateReason =
      product.additionalChecks.length === 0
        ? '확인된 조건이 모두 충족되고 접수 상태가 OPEN입니다. 승인 확정은 아닙니다.'
        : `확인된 조건은 충족하지만 신청 전 ${product.additionalChecks.length}건을 더 확인해야 합니다. 승인 확정은 아닙니다.`;
  } else {
    candidateStatus = 'NEEDS_CONFIRMATION';
    candidateReason = '접수 상태가 OPEN으로 확인되지 않아 현재 신청 가능 후보로 확정하지 않습니다.';
  }

  return {
    productKey: product.productKey,
    version: product.version,
    name: product.name,
    organization: product.organization,
    supportType: product.supportType,
    observedApplicationStatus: product.observedApplicationStatus,
    observedAt: product.observedAt,
    reviewedAt: product.reviewedAt,
    nextReviewAt: product.nextReviewAt,
    officialUrl: product.officialUrl,
    reviewState: state,
    audience,
    primaryEvidenceVerified,
    conditions,
    eligibilityVerdict,
    candidateStatus,
    candidateReason,
    manualChecks: [...product.additionalChecks],
    unsupportedCalculationReasons: [...product.unsupportedCalculationReasons],
    repayment,
  };
}

export function evaluateCandidates(
  catalog: FundingCatalog,
  profile: FundingProfile,
  options: { asOfDate: string },
): FundingCandidateList {
  const evaluations = catalog.products.map((product) => evaluateProduct(product, profile, options));
  const summary = {
    total: evaluations.length,
    CURRENT_CANDIDATE: 0,
    NEEDS_CONFIRMATION: 0,
    NOT_ELIGIBLE: 0,
    POST_REGISTRATION: 0,
    CLOSED: 0,
    REVIEW_OVERDUE: 0,
  } satisfies FundingCandidateSummary;
  for (const evaluation of evaluations) summary[evaluation.candidateStatus] += 1;
  return {
    asOfDate: options.asOfDate,
    basisDate: catalog.basisDate,
    catalogKey: catalog.catalogKey,
    catalogVersion: catalog.catalogVersion,
    profile,
    evaluations,
    summary,
  };
}
