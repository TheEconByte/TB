// 학습 라이브러리 없이 쓰는 로지스틱 회귀(IRLS)와 평가 지표. 변수 수가 적어 정확한 역행렬을 쓴다.

export function sigmoid(value: number): number {
  return value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
}

function invert(matrix: number[][]): number[][] {
  const size = matrix.length;
  const augmented = matrix.map((row, i) => [...row, ...Array.from({ length: size }, (_, j) => (i === j ? 1 : 0))]);
  for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let row = column + 1; row < size; row++) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error('행렬이 특이해 역행렬을 구할 수 없습니다.');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let j = 0; j < 2 * size; j++) augmented[column][j] /= divisor;
    for (let row = 0; row < size; row++) {
      if (row === column) continue;
      const factor = augmented[row][column];
      if (factor === 0) continue;
      for (let j = 0; j < 2 * size; j++) augmented[row][j] -= factor * augmented[column][j];
    }
  }
  return augmented.map((row) => row.slice(size));
}

export type LogisticFit = {
  // [절편, 변수1, 변수2, ...]
  coefficients: number[];
  standardErrors: number[];
  iterations: number;
  converged: boolean;
};

// X에는 절편 열을 넣지 않는다. 결과의 첫 계수가 절편이다.
// penalty[j]는 변수 j 계수의 L2 벌점(½·penalty·β² 를 뺀 우도를 최대화)이다. 없으면 벌점 없는 최대우도다.
export function fitLogistic(
  features: readonly (readonly number[])[],
  labels: readonly number[],
  { maxIterations = 50, tolerance = 1e-10, penalty = [] as readonly number[] } = {},
): LogisticFit & { covariance: number[][] } {
  if (features.length === 0 || features.length !== labels.length)
    throw new Error('학습 표본이 비어 있거나 길이가 다릅니다.');
  const rows = features.map((row) => [1, ...row]);
  const size = rows[0].length;
  const ridge = [0, ...Array.from({ length: size - 1 }, (_, j) => penalty[j] ?? 0)];
  // 부분 통합처럼 대부분이 0인 행은 0이 아닌 열만 더한다.
  const nonZero = rows.map((row) => row.flatMap((value, j) => (value === 0 ? [] : [j])));
  const information = (beta: readonly number[], gradient?: number[]) => {
    const matrix = Array.from({ length: size }, (_, i) =>
      Array.from({ length: size }, (_, j) => (i === j ? ridge[i] : 0)),
    );
    rows.forEach((row, index) => {
      const columns = nonZero[index];
      const probability = sigmoid(columns.reduce((sum, j) => sum + row[j] * beta[j], 0));
      const weight = probability * (1 - probability);
      for (const i of columns) {
        if (gradient) gradient[i] += row[i] * (labels[index] - probability);
        for (const j of columns) matrix[i][j] += weight * row[i] * row[j];
      }
    });
    return matrix;
  };
  let beta = new Array<number>(size).fill(0);
  let converged = false;
  let iterations = 0;

  for (; iterations < maxIterations && !converged; iterations++) {
    const gradient = beta.map((value, i) => -ridge[i] * value);
    const step = invert(information(beta, gradient)).map((row) =>
      row.reduce((sum, value, j) => sum + value * gradient[j], 0),
    );
    beta = beta.map((value, i) => value + step[i]);
    converged = Math.max(...step.map(Math.abs)) < tolerance;
  }

  // 표준오차는 수렴한 계수에서 다시 구한 (벌점을 더한) 정보행렬의 역행렬 대각선이다.
  const covariance = invert(information(beta));
  return {
    coefficients: beta,
    standardErrors: covariance.map((row, i) => Math.sqrt(row[i])),
    covariance,
    iterations,
    converged,
  };
}

// 공통 계수의 벌점. 업종별 편차에 벌점이 없을 때(deviationPenalty 0) 공통 계수와 편차를 나누는 방법이 하나로
// 정해지지 않아 정보행렬이 특이해지는 것을 막는 값이며, 예측값에는 영향이 없다.
const SHARED_PENALTY = 1e-3;

export type PooledLogisticFit = {
  // 업종(그룹)마다 절편과, 공통 계수 + 업종 편차를 더한 계수
  groups: { intercept: number; coefficients: number[]; standardErrors: number[] }[];
  iterations: number;
  converged: boolean;
};

// 부분 통합 로지스틱 회귀. 그룹마다 절편을 따로 두고, 계수는 공통 계수 + 그룹 편차이며 편차에 L2 벌점을 준다.
// 벌점이 0이면 그룹별 따로 학습과 같고, 클수록 표본이 적은 그룹의 계수가 공통 계수로 모인다.
// 설계: [절편(첫 그룹) | 그룹 2..G 절편 차이 | 공통 계수 K | 그룹별 편차 G×K]
export function fitPooledLogistic(
  groups: readonly { features: readonly (readonly number[])[]; labels: readonly number[] }[],
  deviationPenalty: number,
): PooledLogisticFit {
  const groupCount = groups.length;
  const width = groups[0]?.features[0]?.length ?? 0;
  if (groupCount === 0 || width === 0) throw new Error('학습할 그룹이나 변수가 없습니다.');
  const interceptColumns = groupCount - 1;
  const sharedStart = interceptColumns;
  const deviationStart = sharedStart + width;
  const features: number[][] = [];
  const labels: number[] = [];
  groups.forEach((group, g) => {
    group.features.forEach((x, n) => {
      const row = new Array<number>(deviationStart + groupCount * width).fill(0);
      if (g > 0) row[g - 1] = 1;
      for (let k = 0; k < width; k++) {
        row[sharedStart + k] = x[k];
        row[deviationStart + g * width + k] = x[k];
      }
      features.push(row);
      labels.push(group.labels[n]);
    });
  });
  const penalty = [
    ...new Array<number>(interceptColumns).fill(0),
    ...new Array<number>(width).fill(SHARED_PENALTY),
    ...new Array<number>(groupCount * width).fill(deviationPenalty),
  ];
  const fit = fitLogistic(features, labels, { penalty });
  // fit 계수의 첫 값은 절편이라 설계 열 j는 j + 1번째다.
  const at = (column: number) => column + 1;
  return {
    groups: groups.map((_, g) => {
      const interceptIndexes = g === 0 ? [0] : [0, at(g - 1)];
      return {
        intercept: interceptIndexes.reduce((sum, i) => sum + fit.coefficients[i], 0),
        coefficients: Array.from(
          { length: width },
          (_, k) => fit.coefficients[at(sharedStart + k)] + fit.coefficients[at(deviationStart + g * width + k)],
        ),
        // Var(공통 + 편차) = Var(공통) + Var(편차) + 2·Cov
        standardErrors: Array.from({ length: width }, (_, k) => {
          const shared = at(sharedStart + k);
          const deviation = at(deviationStart + g * width + k);
          const c = fit.covariance;
          return Math.sqrt(c[shared][shared] + c[deviation][deviation] + 2 * c[shared][deviation]);
        }),
      };
    }),
    iterations: fit.iterations,
    converged: fit.converged,
  };
}

// Abramowitz-Stegun 7.1.26 근사(오차 1.5e-7).
function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return sign * y;
}

export function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

// Wald 검정의 양측 p값.
export function waldPValue(coefficient: number, standardError: number): number {
  return 2 * (1 - normalCdf(Math.abs(coefficient / standardError)));
}

// 양성(1)이 높은 점수를 받을 확률. 동점은 0.5로 센다.
export function areaUnderCurve(scores: readonly number[], labels: readonly number[]): number {
  const ranked = scores.map((score, index) => ({ score, label: labels[index] })).sort((a, b) => a.score - b.score);
  let rankSumPositive = 0;
  let positives = 0;
  for (let start = 0; start < ranked.length;) {
    let end = start;
    while (end + 1 < ranked.length && ranked[end + 1].score === ranked[start].score) end++;
    const averageRank = (start + end) / 2 + 1;
    for (let i = start; i <= end; i++) {
      if (ranked[i].label === 1) {
        rankSumPositive += averageRank;
        positives++;
      }
    }
    start = end + 1;
  }
  const negatives = ranked.length - positives;
  if (positives === 0 || negatives === 0) throw new Error('AUC는 양성과 음성이 모두 있어야 합니다.');
  return (rankSumPositive - (positives * (positives + 1)) / 2) / (positives * negatives);
}

// KS: 양성(1)과 음성(0)의 점수 누적분포 차이 중 최댓값. 같은 점수는 한 번에 넘긴다.
export function kolmogorovSmirnov(scores: readonly number[], labels: readonly number[]): number {
  const ranked = scores.map((score, index) => ({ score, label: labels[index] })).sort((a, b) => a.score - b.score);
  const positives = ranked.filter((item) => item.label === 1).length;
  const negatives = ranked.length - positives;
  if (positives === 0 || negatives === 0) throw new Error('KS는 양성과 음성이 모두 있어야 합니다.');
  let seenPositive = 0;
  let seenNegative = 0;
  let maximum = 0;
  for (let i = 0; i < ranked.length; i++) {
    if (ranked[i].label === 1) seenPositive++;
    else seenNegative++;
    if (i + 1 < ranked.length && ranked[i + 1].score === ranked[i].score) continue;
    maximum = Math.max(maximum, Math.abs(seenPositive / positives - seenNegative / negatives));
  }
  return maximum;
}

export function meanAndStd(values: readonly number[]): { mean: number; std: number } {
  if (values.length < 2) throw new Error('표준화에는 값이 2개 이상 필요합니다.');
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return { mean, std: Math.sqrt(variance) };
}

export function pearson(left: readonly number[], right: readonly number[]): number {
  const a = meanAndStd(left);
  const b = meanAndStd(right);
  const covariance =
    left.reduce((sum, value, i) => sum + (value - a.mean) * (right[i] - b.mean), 0) / (left.length - 1);
  return covariance / (a.std * b.std);
}
