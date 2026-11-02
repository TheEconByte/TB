// 상권 생존점수 모델 정의(ADR 0008). 학습(score:train)과 점수 계산(score:build·API)이
// 같은 설정을 읽는다. 변수를 추가할 때는 dataset.ts에 정의를 더하고 ACTIVE_FEATURE_KEYS에 넣는다.

export const MODEL_DEFINITION_VERSION = 'market-score-def-v3';
// 점수 릴리스 행·요약의 저장 형식 버전. 바꾸면 같은 계수 파일로도 새 점수 릴리스를 만든다.
export const SCORE_BUILD_VERSION = 'market-score-build-v1';

// 표준화 값을 ±Z_CLIP에서 자른다. 극단값 상권 하나가 점수를 좌우하지 않게 하려는 것이며, 원값은 바꾸지 않는다.
export const Z_CLIP = 3;
// 월매출 기본값이 같은 업종 점수 낸 상권의 하위·상위 분위수 밖이면 화면에 경고를 붙인다.
export const MONTHLY_REVENUE_WARNING_QUANTILES = { low: 0.01, high: 0.99 } as const;

// 업종 모델의 테스트 AUC가 이보다 낮으면 그 업종은 점수를 내지 않는다(미지원 업종).
export const MIN_TEST_AUC = 0.6;
// 등급 단조성 판정에서 테스트 표본이 이보다 적은 등급은 따로 표시하고 판정에서 뺀다.
export const MONOTONIC_MIN_GRADE_COUNT = 30;

// 서울시 상위 업종 중 점수를 내는 업종. 업종마다 모델을 따로 학습한다.
export const SCORE_INDUSTRY_CODES = ['CS100001', 'CS100010'] as const;
export type ScoreIndustryCode = (typeof SCORE_INDUSTRY_CODES)[number];

export function isScoreIndustry(code: string): code is ScoreIndustryCode {
  return (SCORE_INDUSTRY_CODES as readonly string[]).includes(code);
}

// t 분기 점포 수가 이보다 적으면 학습과 화면에서 모두 뺀다.
export const MIN_STORE_COUNT = 5;

// 라벨: t+1 ~ t+4 분기 폐업 수 합 ÷ t 분기 점포 수.
export const LABEL_HORIZON_QUARTERS = 4;
// 매출 증감률의 비교 시차(전년 같은 분기).
export const GROWTH_LAG_QUARTERS = 4;
// 점포당 매출을 합산하는 분기 수(t−3 ~ t).
export const PER_STORE_WINDOW_QUARTERS = 4;
// 시간 기준 분할: 마지막 기준분기 4개가 테스트셋이다.
export const TEST_QUARTER_COUNT = 4;

export type FeatureKey =
  'salesGrowth' | 'salesPerStore' | 'storeCount' | 'pastClosureRate' | 'pastOpenRate' | 'franchiseShare';

// 요청서 원안의 1차 변수. 비교용으로 리포트에 남긴다.
export const FIRST_ORDER_FEATURE_KEYS: readonly FeatureKey[] = ['salesGrowth', 'salesPerStore', 'storeCount'];

// 채택 모델 변수(ADR 0008): 1차 변수 + 이미 적재된 서울시 점포 자료의 직전 1년 폐업률·개업률, 프랜차이즈 비중.
// 길단위인구·상권변화지표·임대료는 2차 범위다.
export const ACTIVE_FEATURE_KEYS: readonly FeatureKey[] = [
  ...FIRST_ORDER_FEATURE_KEYS,
  'pastClosureRate',
  'pastOpenRate',
  'franchiseShare',
];

// 기준선 비교: 같은 학습·테스트 행으로 학습해 생존점수 모델이 공개 위험 지표보다 변별력을 더 주는지 본다.
// 상권변화지표를 적재하면 4단계 지표 더미 변수로 된 기준선 2를 여기에 더한다.
export type ComparisonModelId = 'baseline' | 'firstOrder' | 'combined' | 'survival';
export const COMPARISON_MODELS: readonly {
  id: ComparisonModelId;
  label: string;
  featureKeys: readonly FeatureKey[];
}[] = [
  { id: 'baseline', label: '기준선', featureKeys: ['pastClosureRate'] },
  { id: 'firstOrder', label: '1차 모델(원안)', featureKeys: FIRST_ORDER_FEATURE_KEYS },
  { id: 'combined', label: '결합 모델(원안)', featureKeys: ['pastClosureRate', ...FIRST_ORDER_FEATURE_KEYS] },
  { id: 'survival', label: '생존점수 모델(채택)', featureKeys: ACTIVE_FEATURE_KEYS },
];

export const GRADES = ['AAA', 'AA', 'A', 'BBB', 'BB', 'B', 'C', 'D'] as const;
export type Grade = (typeof GRADES)[number];

// 초기 등급 경계(점수 하한). 학습 리포트를 보고 조정하면 계수 파일에 함께 기록한다.
export const DEFAULT_GRADE_BOUNDARIES: readonly { grade: Grade; minScore: number }[] = [
  { grade: 'AAA', minScore: 90 },
  { grade: 'AA', minScore: 80 },
  { grade: 'A', minScore: 70 },
  { grade: 'BBB', minScore: 60 },
  { grade: 'BB', minScore: 50 },
  { grade: 'B', minScore: 40 },
  { grade: 'C', minScore: 30 },
  { grade: 'D', minScore: 0 },
];
