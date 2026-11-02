import { basisPeriodLabel, quarterLabel } from '../quarter.ts';
import { MIN_TEST_AUC, MONOTONIC_MIN_GRADE_COUNT } from './config.ts';
import type { ExclusionReason } from './dataset.ts';
import type { MarketScoreModel } from './model.ts';
import {
  isMonotonic,
  scoreBins,
  type GradeOutcome,
  type IndustryTrainingResult,
  type QuarterScore,
  type SampleExclusion,
} from './train.ts';

function monotonicLabel(outcomes: readonly GradeOutcome[], minCount: number): string {
  const skipped = outcomes.filter((item) => item.count > 0 && item.count < minCount).map((item) => item.grade);
  return (
    (isMonotonic(outcomes, minCount) ? '예' : '**아니오**') + (skipped.length ? ` (제외: ${skipped.join('·')})` : '')
  );
}

const EXCLUSION_LABELS: Record<SampleExclusion, string> = {
  NO_DATA: '행·점포 수 없음',
  FEW_STORES: '점포 수 최소 미만',
  NO_SALES: 't 매출 0·없음',
  NO_PRIOR_SALES: 't−4 매출 0·없음',
  INCOMPLETE_WINDOW: 't−3~t−1 값 없음',
  FEATURE_UNAVAILABLE: '폐업·개업·프랜차이즈 값 없음',
  NO_FUTURE_DATA: 't+1~t+4 폐업 수 없음',
};

const percent = (value: number | null) => (value === null ? '—' : `${(value * 100).toFixed(1)}%`);
const fixed = (value: number, digits = 3) => value.toFixed(digits);
const pValue = (value: number) => (value < 0.001 ? '<0.001' : value.toFixed(3));

export type LatestQuarterSummary = {
  quarter: string;
  scores: QuarterScore[];
  exclusions: Record<ExclusionReason, number>;
};

function industrySection(
  result: IndustryTrainingResult,
  latest: LatestQuarterSummary,
  model: MarketScoreModel,
): string {
  const m = result.model;
  const lines: string[] = [];
  lines.push(`## ${m.industryName} (${m.industryCode})`, '');
  lines.push('### 표본', '');
  lines.push('| 구분 | 기준분기 | 표본 수 | 라벨 1 비율 | AUC |', '|---|---|---|---|---|');
  lines.push(
    `| 학습 | ${basisPeriodLabel(m.trainQuarters[0], m.trainQuarters.at(-1)!)} (${m.trainQuarters.length}개) | ${m.trainSize} | ${percent(m.trainPositiveRate)} | ${fixed(m.trainAuc)} |`,
  );
  lines.push(
    `| 테스트 | ${basisPeriodLabel(m.testQuarters[0], m.testQuarters.at(-1)!)} (${m.testQuarters.length}개) | ${m.testSize} | ${percent(m.testPositiveRate)} | **${fixed(m.testAuc)}** |`,
  );
  lines.push('', `IRLS ${result.iterations}회 반복, 수렴 ${result.converged ? '예' : '아니오'}.`, '');

  lines.push('기준분기별 표본과 제외 사유:', '');
  const reasons = Object.keys(EXCLUSION_LABELS) as SampleExclusion[];
  lines.push(`| 기준분기 | 표본 | 폐업률 중앙값 | ${reasons.map((key) => EXCLUSION_LABELS[key]).join(' | ')} |`);
  lines.push(`|---|---|---|${reasons.map(() => '---').join('|')}|`);
  for (const item of result.quarterSamples) {
    lines.push(
      `| ${quarterLabel(item.quarter)} | ${item.samples.length} | ${item.median === null ? '—' : percent(item.median)} | ${reasons.map((key) => item.exclusions[key]).join(' | ')} |`,
    );
  }

  lines.push('', '### 계수 (고폐업 확률 기준, 표준화)', '');
  lines.push(
    '| 변수 | 정의 | β | 표준오차 | p값 | 점수 방향 | 예상 방향 | 일치 |',
    '|---|---|---|---|---|---|---|---|',
  );
  lines.push(`| 절편 | | ${fixed(m.intercept)} | | | | | |`);
  for (const feature of m.features) {
    const scoreDirection = -feature.beta > 0 ? '올림' : '내림';
    const expected =
      feature.expectedScoreDirection === 0 ? '없음' : feature.expectedScoreDirection > 0 ? '올림' : '내림';
    const matches =
      feature.expectedScoreDirection === 0
        ? '—'
        : Math.sign(-feature.beta) === feature.expectedScoreDirection
          ? '예'
          : '**아니오 (부호 반대)**';
    lines.push(
      `| ${feature.label} | ${feature.definition} | ${fixed(feature.beta)} | ${fixed(feature.standardError)} | ${pValue(feature.pValue)} | ${scoreDirection} | ${expected} | ${matches} |`,
    );
  }
  lines.push(
    '',
    '표준화 기준(학습셋): ' +
      m.features.map((f) => `${f.label} 평균 ${fixed(f.mean)}, 표준편차 ${fixed(f.std)}`).join(' / '),
  );

  lines.push('', '### 변수 간 상관 (학습셋, |r| ≥ 0.7 표시)', '');
  lines.push('| 변수 쌍 | r | 0.7 이상 |', '|---|---|---|');
  for (const item of result.correlations) {
    const left = m.features.find((f) => f.key === item.left)!.label;
    const right = m.features.find((f) => f.key === item.right)!.label;
    lines.push(`| ${left} – ${right} | ${fixed(item.r)} | ${Math.abs(item.r) >= 0.7 ? '**예**' : '아니오'} |`);
  }

  const sortedBoundaries = [...model.gradeBoundaries].sort((a, b) => b.minScore - a.minScore);
  lines.push('', '### 기준선 비교 (같은 학습·테스트 행)', '');
  lines.push(
    `모든 모델을 학습 ${m.trainSize}행·테스트 ${m.testSize}행으로 로지스틱 회귀 학습하고, 같은 점수 변환과 등급 구간을 적용했다. KS는 0~100 점수로 계산했다. 등급 단조는 모든 등급 기준과, 테스트 표본 ${MONOTONIC_MIN_GRADE_COUNT}건 미만 등급을 뺀 기준을 함께 적는다.`,
    '',
  );
  lines.push(
    `| 모델 | 변수 | 테스트 AUC | KS | 등급 단조(전체) | 등급 단조(${MONOTONIC_MIN_GRADE_COUNT}건 이상) | β (고폐업 기준, 표준화) |`,
    '|---|---|---|---|---|---|---|',
  );
  for (const item of result.comparisons) {
    lines.push(
      `| ${item.label} | ${item.model.features.map((f) => f.label).join(', ')} | ${fixed(item.evaluation.testAuc)} | ${fixed(item.evaluation.ks)} | ${monotonicLabel(item.evaluation.gradeOutcomes, 1)} | ${monotonicLabel(item.evaluation.gradeOutcomes, MONOTONIC_MIN_GRADE_COUNT)} | ${item.model.features.map((f) => `${f.label} ${fixed(f.beta)} (p ${pValue(f.pValue)})`).join(', ')} |`,
    );
  }
  const baseline = result.comparisons.find((item) => item.id === 'baseline');
  const survival = result.comparisons.find((item) => item.id === 'survival');
  if (baseline && survival) {
    const aucGap = survival.evaluation.testAuc - baseline.evaluation.testAuc;
    const ksGap = survival.evaluation.ks - baseline.evaluation.ks;
    lines.push(
      '',
      `생존점수 모델 − 기준선: AUC ${aucGap >= 0 ? '+' : ''}${fixed(aucGap)}, KS ${ksGap >= 0 ? '+' : ''}${fixed(ksGap)}. ` +
        (aucGap > 0 && ksGap > 0
          ? 'AUC와 KS 모두 생존점수 모델이 기준선보다 높다.'
          : aucGap <= 0 && ksGap <= 0
            ? '**AUC와 KS 모두 생존점수 모델이 기준선보다 높지 않다.**'
            : '**AUC와 KS의 방향이 엇갈려 생존점수 모델이 기준선보다 낫다고 볼 수 없다.**') +
        ' 유의성 검정은 하지 않았다.',
    );
  }
  lines.push('', '기준선 2(상권변화지표 4단계 더미 변수)는 상권변화지표가 적재되지 않아 생략했다.');

  lines.push('', '#### 등급별 테스트셋 결과 (상권·분기 수 / 고폐업 비율 / 실제 향후 1년 폐업률 평균)', '');
  lines.push(
    `| 등급 | 점수 | ${result.comparisons.map((item) => `${item.label} 수 | 고폐업 | 폐업률`).join(' | ')} |`,
    `|---|---|${result.comparisons.map(() => '---|---|---').join('|')}|`,
  );
  sortedBoundaries.forEach(({ grade, minScore }, index) => {
    const upper = index === 0 ? 100 : sortedBoundaries[index - 1].minScore - 1;
    const cells = result.comparisons.map((item) => {
      const outcome = item.evaluation.gradeOutcomes.find((o) => o.grade === grade)!;
      return `${outcome.count} | ${percent(outcome.highClosureRate)} | ${percent(outcome.meanClosureRate)}`;
    });
    lines.push(`| ${grade} | ${minScore}~${upper} | ${cells.join(' | ')} |`);
  });

  lines.push('', '### 생존점수 모델 테스트셋 점수 분포 (10점 구간)', '');
  lines.push(binTable(scoreBins(result.evaluation.testScores)));

  lines.push('', `### 최신 기준분기 ${quarterLabel(latest.quarter)} 점수 (화면에 쓰는 값)`, '');
  lines.push(
    `점수 낸 상권 ${latest.scores.length}곳. 제외: ` +
      (Object.keys(latest.exclusions) as ExclusionReason[])
        .map((key) => `${EXCLUSION_LABELS[key]} ${latest.exclusions[key]}`)
        .join(', '),
    '',
  );
  lines.push(binTable(scoreBins(latest.scores.map((item) => item.scored.score))));
  lines.push('', '| 등급 | 상권 수 |', '|---|---|');
  for (const { grade } of sortedBoundaries) {
    lines.push(`| ${grade} | ${latest.scores.filter((item) => item.scored.grade === grade).length} |`);
  }
  return lines.join('\n');
}

function binTable(bins: { from: number; to: number; count: number }[]): string {
  return [
    `| 구간 | ${bins.map((bin) => `${bin.from}~${bin.to}`).join(' | ')} |`,
    `|---|${bins.map(() => '---').join('|')}|`,
    `| 수 | ${bins.map((bin) => bin.count).join(' | ')} |`,
  ].join('\n');
}

export function renderTrainingReport(input: {
  model: MarketScoreModel;
  results: IndustryTrainingResult[];
  latest: Record<string, LatestQuarterSummary>;
}): string {
  const { model } = input;
  const failures = input.results.filter((result) => result.model.testAuc < MIN_TEST_AUC);
  const header = [
    `# 상권 생존점수 학습 리포트: ${model.version}`,
    '',
    `- 모델 정의: ${model.definitionVersion} ([ADR 0008](../../../docs/decisions/0008-market-survival-score.md))`,
    `- 상권 릴리스: \`${model.marketReleaseKey}\` (${basisPeriodLabel(model.dataPeriod.start, model.dataPeriod.end)})`,
    `- 생성 시각: ${model.createdAt}`,
    `- 최소 점포 수: ${model.minStoreCount}, 점포 수는 유사_업종_점포_수`,
    '- 라벨: 향후 1년(t+1~t+4) 폐업 수 합 ÷ t 점포 수가 같은 업종·기준분기 서울 상권 중앙값보다 크면 1',
    '- 점수 = round((1 − p) × 100), 기여도 = −β × z',
    `- 표준화 값 z는 학습과 점수 계산 모두 ±${model.industries[0]?.zClip ?? '—'}에서 자른다(극단값 완화, 원값은 그대로)`,
    '',
    failures.length === 0
      ? `채택 모델 테스트 AUC ${MIN_TEST_AUC} 기준: **모든 업종 통과**`
      : `채택 모델 테스트 AUC ${MIN_TEST_AUC} 기준: **미달 — ${failures.map((r) => r.model.industryName).join(', ')}**. 미달 업종은 점수를 내지 않는다(미지원 업종).`,
    '',
    '## 요약: 업종·모델별 테스트 지표',
    '',
    `| 업종 | 모델 | 테스트 AUC | KS | 등급 단조(전체) | 등급 단조(${MONOTONIC_MIN_GRADE_COUNT}건 이상) |`,
    '|---|---|---|---|---|---|',
    ...input.results.flatMap((result) =>
      result.comparisons.map(
        (item) =>
          `| ${result.model.industryName} | ${item.label} | ${fixed(item.evaluation.testAuc)} | ${fixed(item.evaluation.ks)} | ${monotonicLabel(item.evaluation.gradeOutcomes, 1)} | ${monotonicLabel(item.evaluation.gradeOutcomes, MONOTONIC_MIN_GRADE_COUNT)} |`,
      ),
    ),
    '',
    '',
  ].join('\n');
  return (
    header +
    input.results
      .map((result) => industrySection(result, input.latest[result.model.industryCode], model))
      .join('\n\n') +
    '\n'
  );
}
