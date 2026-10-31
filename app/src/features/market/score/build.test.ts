import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { compareDisplay, scoreStatusMessage, topContributions } from './api.ts';
import { buildScores, quantile, rankScores, revenueOutlier, topPercent, type ScoreDetail } from './build.ts';
import { DEFAULT_GRADE_BOUNDARIES } from './config.ts';
import type { AreaSeries, QuarterObservation } from './dataset.ts';
import { handoffFromSearch, handoffSearch, parseHandoff } from './handoff.ts';
import type { IndustryModel, MarketScoreModel } from './model.ts';

function series(areaCode: string, entries: Record<string, Partial<QuarterObservation>>): AreaSeries {
  const byQuarter = new Map<string, QuarterObservation>();
  for (const [quarter, value] of Object.entries(entries)) {
    byQuarter.set(quarter, {
      salesAmount: '1000',
      storeCount: 10,
      closedStoreCount: 1,
      openedStoreCount: 1,
      franchiseStoreCount: 1,
      ...value,
    });
  }
  return { areaType: 'A', areaCode, industryCode: 'CS100001', byQuarter };
}

const QUARTERS = ['20252', '20253', '20254', '20261', '20262'];
const full = (areaCode: string, overrides: Record<string, Partial<QuarterObservation>> = {}) =>
  series(areaCode, Object.fromEntries(QUARTERS.map((quarter) => [quarter, overrides[quarter] ?? {}])));

function industry(code: string, testAuc: number): IndustryModel {
  return {
    industryCode: code,
    industryName: code === 'CS100001' ? '한식' : '커피·음료',
    intercept: 0,
    features: [
      {
        key: 'salesPerStore',
        label: '점포당 매출',
        definition: '',
        expectedScoreDirection: 1,
        beta: -1,
        standardError: 0.1,
        pValue: 0,
        mean: Math.log(400),
        std: 1,
      },
      {
        key: 'storeCount',
        label: '동일 업종 점포 수',
        definition: '',
        expectedScoreDirection: 0,
        beta: 0.5,
        standardError: 0.1,
        pValue: 0,
        mean: Math.log(10),
        std: 1,
      },
    ],
    trainQuarters: ['20221'],
    testQuarters: ['20243'],
    trainSize: 100,
    testSize: 40,
    trainPositiveRate: 0.5,
    testPositiveRate: 0.5,
    trainAuc: 0.7,
    testAuc,
    zClip: 3,
  };
}

const model: MarketScoreModel = {
  version: 'market-score-test',
  definitionVersion: 'market-score-def-test',
  createdAt: '2026-10-31T00:00:00.000Z',
  marketReleaseKey: 'seoul-market-test',
  dataPeriod: { start: '20252', end: '20262' },
  minStoreCount: 5,
  gradeBoundaries: [...DEFAULT_GRADE_BOUNDARIES],
  industries: [industry('CS100001', 0.65), industry('CS100010', 0.55)],
};

describe('순위와 분위수', () => {
  it('점수가 같으면 같은 순위이고 상위 %는 올림한다', () => {
    expect(rankScores([70, 90, 70, 50])).toEqual([2, 1, 2, 4]);
    expect(topPercent(1, 1283)).toBe(1);
    expect(topPercent(770, 1283)).toBe(61);
    expect(topPercent(4, 4)).toBe(100);
  });

  it('월매출 기본값이 하위·상위 경계 밖이면 방향을 알려 준다', () => {
    const range = { low: '1000000', high: '189115558' };
    expect(revenueOutlier('1286587578', range)).toBe('HIGH');
    expect(revenueOutlier('79150', range)).toBe('LOW');
    expect(revenueOutlier('29684576', range)).toBeNull();
    expect(revenueOutlier('189115558', range)).toBeNull();
    expect(revenueOutlier('79150', null)).toBeNull();
  });

  it('분위수는 최근접 순위로 구하고 값이 없으면 null이다', () => {
    const values = [5, 1, 4, 2, 3].map((value) => new Decimal(value));
    expect(quantile(values, 0.99)).toBe('5');
    expect(quantile(values, 0.5)).toBe('3');
    expect(quantile([], 0.99)).toBeNull();
  });
});

describe('점수 생성', () => {
  const areas = ['3110001', '3110002', '3110003', '3110004'].map((areaCode) => ({ areaType: 'A', areaCode }));
  const seriesByIndustry = new Map([
    [
      'CS100001',
      [
        full('3110001'),
        // 점포당 매출이 높은 상권
        full('3110002', Object.fromEntries(QUARTERS.map((quarter) => [quarter, { salesAmount: '8000' }]))),
        full('3110003', { '20262': { storeCount: 3 } }),
      ],
    ],
  ]);
  const { rows, summary } = buildScores({ model, seriesByIndustry, areas, quarter: '20262' });

  it('AUC 기준 미달 업종은 행을 만들지 않고 미지원으로 기록한다', () => {
    expect(summary.servedIndustryCodes).toEqual(['CS100001']);
    expect(summary.industries.find((item) => item.industryCode === 'CS100010')).toMatchObject({
      served: false,
      scoredCount: 0,
    });
    expect(rows.every((row) => row.industryCode === 'CS100001')).toBe(true);
    expect(rows).toHaveLength(4);
  });

  it('상권마다 정상·표본 부족·데이터 없음을 구분한다', () => {
    const byArea = Object.fromEntries(rows.map((row) => [row.areaCode, row]));
    expect(byArea['3110001']).toMatchObject({ status: 'SCORED', storeCount: 10 });
    expect(byArea['3110003']).toMatchObject({ status: 'INSUFFICIENT_STORES', storeCount: 3, score: null });
    expect(byArea['3110004']).toMatchObject({ status: 'NO_DATA', storeCount: null, score: null });
  });

  it('월매출 기본값은 최근 4분기 매출 원값 합 ÷ 점포 수 합이다(ADR 0002)', () => {
    const row = rows.find((item) => item.areaCode === '3110001')!;
    // 1000원 × 4분기 ÷ 점포 10개 × 4분기
    expect(row.monthlyRevenueDefault).toBe('100');
    expect(row.detail?.monthlyRevenueBasis).toEqual({
      quarters: ['20253', '20254', '20261', '20262'],
      salesSum: '4000',
      storeCountSum: 40,
    });
  });

  it('순위·분포·등급 수·변수 평균·상위 1% 경계를 업종별로 남긴다', () => {
    const scored = rows.filter((row) => row.status === 'SCORED');
    expect(scored.map((row) => row.rank).sort()).toEqual([1, 2]);
    expect(rows.find((row) => row.areaCode === '3110002')!.rank).toBe(1);
    const korean = summary.industries.find((item) => item.industryCode === 'CS100001')!;
    expect(korean.scoredCount).toBe(2);
    expect(korean.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(2);
    expect(Object.values(korean.gradeCounts).reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(korean.featureAverages.salesPerStore).toBe('450');
    expect(korean.featureAverages.storeCount).toBe('10');
    expect(korean.monthlyRevenueWarningRange).toEqual({ low: '100', high: '800' });
    expect(korean.exclusions.FEW_STORES).toBe(1);
  });
});

describe('점수 API 응답 조립', () => {
  it('예외 상태 4가지의 문구', () => {
    expect(scoreStatusMessage('OK', 10, ['한식'])).toBeNull();
    expect(scoreStatusMessage('INSUFFICIENT_STORES', 3, ['한식'])).toBe('점포가 3개뿐이라 점수를 내지 않습니다.');
    expect(scoreStatusMessage('INSUFFICIENT_STORES', 0, ['한식'])).toBe(
      '이 상권에는 이 업종 점포가 없어 점수를 내지 않습니다.',
    );
    expect(scoreStatusMessage('UNSUPPORTED_INDUSTRY', null, ['한식'])).toBe('현재 한식만 지원합니다.');
    expect(scoreStatusMessage('UNSUPPORTED_INDUSTRY', null, ['한식', '커피·음료'])).toBe(
      '현재 한식·커피·음료만 지원합니다.',
    );
    expect(scoreStatusMessage('NO_DATA', null, ['한식'])).toBe('이 상권은 최근 데이터가 없습니다.');
  });

  it('기여 변수는 절댓값 순 최대 4개이고, 높음·낮음은 실제 값으로, 올림·내림은 기여도 부호로 정한다', () => {
    const feature = (key: string, displayValue: string, contribution: number) => ({
      key,
      label: key,
      displayLabel: key,
      unit: 'PERCENT',
      displayValue,
      value: 0,
      z: 0,
      contribution,
    });
    const detail = {
      features: [
        feature('salesGrowth', '0.100000', 0.1),
        feature('salesPerStore', '0.100000', -0.9),
        feature('storeCount', '0.100000', 0.5),
        feature('pastClosureRate', '0.050000', 0.3),
        feature('pastOpenRate', '0.200000', -0.4),
      ],
      monthlyRevenueBasis: { quarters: [], salesSum: '0', storeCountSum: 1 },
    } as unknown as ScoreDetail;
    const result = topContributions(detail, {
      salesPerStore: '0.050000',
      storeCount: '0.100000',
      pastClosureRate: '0.080000',
      pastOpenRate: '0.100000',
    });
    expect(result.map((item) => item.key)).toEqual(['salesPerStore', 'storeCount', 'pastOpenRate', 'pastClosureRate']);
    // 평균보다 높은데 점수를 내린 변수도 있다. 두 판정은 서로 독립이다.
    expect(result[0]).toMatchObject({ comparison: 'HIGHER', effect: 'LOWERS' });
    expect(result[1]).toMatchObject({ comparison: 'SAME', effect: 'RAISES' });
    expect(result[3]).toMatchObject({ comparison: 'LOWER', effect: 'RAISES' });
    expect(compareDisplay('1286587578', '60887550')).toBe('HIGHER');
  });
});

describe('재무 계획으로 넘기는 상권 참조', () => {
  const handoff = {
    areaType: 'A',
    areaCode: '3110020',
    industryCode: 'CS100001',
    releaseKey: 'market-score-v3-20262-x1',
  };

  it('URL로 오가며 값이 그대로 남는다', () => {
    expect(handoffFromSearch(handoffSearch(handoff))).toEqual(handoff);
  });

  it('형식이 틀린 값은 받지 않는다', () => {
    expect(parseHandoff({ ...handoff, areaCode: '31100' })).toBeNull();
    expect(parseHandoff({ ...handoff, industryCode: 'CS10001' })).toBeNull();
    expect(parseHandoff({ ...handoff, releaseKey: 'Release Key' })).toBeNull();
    expect(handoffFromSearch('?scoreArea=3110020')).toBeNull();
  });
});
