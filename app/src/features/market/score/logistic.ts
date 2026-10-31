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
export function fitLogistic(
  features: readonly (readonly number[])[],
  labels: readonly number[],
  { maxIterations = 50, tolerance = 1e-10 } = {},
): LogisticFit {
  if (features.length === 0 || features.length !== labels.length)
    throw new Error('학습 표본이 비어 있거나 길이가 다릅니다.');
  const rows = features.map((row) => [1, ...row]);
  const size = rows[0].length;
  let beta = new Array<number>(size).fill(0);
  let information: number[][] = [];
  let converged = false;
  let iterations = 0;

  for (; iterations < maxIterations && !converged; iterations++) {
    const gradient = new Array<number>(size).fill(0);
    information = Array.from({ length: size }, () => new Array<number>(size).fill(0));
    rows.forEach((row, index) => {
      const probability = sigmoid(row.reduce((sum, value, j) => sum + value * beta[j], 0));
      const weight = probability * (1 - probability);
      for (let i = 0; i < size; i++) {
        gradient[i] += row[i] * (labels[index] - probability);
        for (let j = 0; j < size; j++) information[i][j] += weight * row[i] * row[j];
      }
    });
    const step = invert(information).map((row) => row.reduce((sum, value, j) => sum + value * gradient[j], 0));
    beta = beta.map((value, i) => value + step[i]);
    converged = Math.max(...step.map(Math.abs)) < tolerance;
  }

  // 표준오차는 수렴한 계수에서 다시 구한 정보행렬의 역행렬 대각선이다.
  const finalInformation = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  for (const row of rows) {
    const probability = sigmoid(row.reduce((sum, value, j) => sum + value * beta[j], 0));
    const weight = probability * (1 - probability);
    for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) finalInformation[i][j] += weight * row[i] * row[j];
  }
  const covariance = invert(finalInformation);
  return {
    coefficients: beta,
    standardErrors: covariance.map((row, i) => Math.sqrt(row[i])),
    iterations,
    converged,
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
