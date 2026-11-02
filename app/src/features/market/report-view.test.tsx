import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarketReportView } from './MarketExplorer';
import { PROVISIONAL_SALES_BASIS, provisionalQuarterSales } from './provisional.ts';
import { quarterLabel } from './quarter.ts';
import {
  INDICATOR_DEFINITIONS,
  MARKET_LIMITATIONS,
  type MarketReport,
  type QuarterIndicatorRow,
  type SalesBreakdown,
} from './types.ts';

// /markets 보고서 화면의 표시 규칙. 기대 문구는 요구에서 정했다.
// - 세부 업종 경쟁 점포는 소진공 자치구 스냅샷이라 상권·업종 분기 자료가 없어도 보여야 한다(리뷰 지적, 이전 화면 동작).
// - 실제 0과 자료 없음(null)을 같은 문구로 쓰지 않는다(AGENTS.md §3-2).

function row(quarter: string, overrides: Partial<QuarterIndicatorRow> = {}): QuarterIndicatorRow {
  return {
    quarter,
    label: quarterLabel(quarter),
    salesAmount: '30000000',
    salesCount: '1500',
    salesBreakdown: null,
    salesStatus: 'OBSERVED',
    storeCount: 8,
    similarIndustryStoreCount: 10,
    franchiseStoreCount: 2,
    openedStoreCount: 1,
    closedStoreCount: 0,
    ...overrides,
  };
}

function report(quarters: QuarterIndicatorRow[]): MarketReport {
  return {
    release: {
      releaseKey: 'seoul-market-test',
      label: '테스트 릴리스',
      basisPeriod: '20251',
      basisPeriodLabel: '2025년 1분기',
      retrievedAt: '2026-01-01T00:00:00.000Z',
      activatedAt: null,
      schemaVersion: 'market-schema-v1.1.0',
      definitionVersion: 'seoul-market-definition-2024-2025-v2',
      sourceUrl: 'https://data.seoul.go.kr/',
      areaCount: 1,
      quarterlyRowCount: quarters.length,
      sources: [],
    },
    area: {
      areaType: 'A',
      areaCode: '3110001',
      displayName: '테스트상권',
      displayNameSource: 'AREA_FILE',
      sourceName: '테스트상권',
      observedName: null,
      nameMismatch: false,
      areaTypeName: '골목상권',
      districtCode: '11110',
      districtName: '종로구',
    },
    industry: {
      code: 'CS100001',
      sourceName: '한식음식점',
      displayName: '한식',
      displayNameSource: 'PRODUCT_DOCUMENT',
      sourceCategoryVersion: 'seoul-service-industry-2024-2025',
    },
    availableQuarters: quarters.map((quarter) => ({ quarter: quarter.quarter, label: quarter.label })),
    quarters,
    dataStatus: quarters.length === 0 ? 'NOT_PROVIDED' : 'AVAILABLE',
    dataStatusMessage: null,
    indicators: INDICATOR_DEFINITIONS,
    limitations: MARKET_LIMITATIONS,
    observedScope: { kind: 'BROAD_INDUSTRY', code: 'CS100001', label: '한식', statement: '상위 업종 전체 기준입니다.' },
    competitionScope: null,
    sourceRelease: 'seoul-market-test',
    asOf: quarters.at(-1)?.quarter ?? null,
    nullReason: null,
    provisionalSales: { basis: PROVISIONAL_SALES_BASIS, quarters: quarters.map(provisionalQuarterSales) },
  };
}

const COMPETITION_MARKER = '경쟁 점포 표시 확인용 문장';

function renderHtml(summary: MarketReport): string {
  return renderToStaticMarkup(
    <MarketReportView
      summary={summary}
      selectedArea={null}
      detailedCategoryName="한식 일반 음식점"
      competition={<p>{COMPETITION_MARKER}</p>}
    />,
  );
}

function renderText(summary: MarketReport): string {
  return renderHtml(summary).replace(/<[^>]+>/g, '');
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

describe('market report competition section', () => {
  it('keeps the detailed-industry competition when the area has no quarter rows', () => {
    const text = renderText(report([]));
    expect(text).toContain('자료 부족');
    expect(occurrences(text, COMPETITION_MARKER)).toBe(1);
  });

  it('shows the competition once in a full report', () => {
    const text = renderText(report([row('20244'), row('20251')]));
    expect(occurrences(text, COMPETITION_MARKER)).toBe(1);
  });
});

describe('market report keeps an observed zero apart from missing data', () => {
  it('says both store counts are zero instead of calling them missing', () => {
    const text = renderText(
      report([row('20251', { storeCount: 0, franchiseStoreCount: 0, similarIndustryStoreCount: 0 })]),
    );
    expect(text).toContain('모두 0개');
    expect(text).not.toContain('구성 자료가 없어');
    expect(text).not.toContain('NaN');
  });

  it('still calls a missing store count missing', () => {
    const text = renderText(report([row('20251', { storeCount: null })]));
    expect(text).toContain('구성 자료가 없어');
  });

  it('says the per-store denominator is zero instead of missing', () => {
    const text = renderText(
      report([row('20251', { similarIndustryStoreCount: 0, storeCount: 0, franchiseStoreCount: 0 })]),
    );
    expect(text).toContain('점포 수가 0개');
    expect(text).not.toContain('점포 수가 없어');
  });

  it('still calls a missing per-store denominator missing', () => {
    const text = renderText(report([row('20251', { similarIndustryStoreCount: null })]));
    expect(text).toContain('유사 업종 점포 수가 없어');
  });

  it('says the payment count is zero instead of missing', () => {
    const text = renderText(report([row('20251', { salesCount: '0' })]));
    expect(text).toContain('매출 건수가 0건');
    expect(text).not.toContain('건수가 없어');
  });

  it('still calls a missing payment count missing', () => {
    const text = renderText(report([row('20251', { salesCount: null })]));
    expect(text).toContain('건수가 없어');
  });

  // 문장뿐 아니라 차트·원본 표·비중 막대도 같은 규칙이다. 관측된 0은 '자료 부족' 표시를 하나도 늘리지 않아야 한다.
  // 기준은 같은 모양의 완전한 자료다(표 아래 설명 문장에 '자료 부족'이라는 말이 늘 들어 있다).
  it('adds no missing-data label anywhere for observed zeros', () => {
    const baseline = occurrences(
      renderText(report([row('20251', { salesBreakdown: breakdown('1000') })])),
      '자료 부족',
    );
    const zeroStores = row('20251', { storeCount: 0, franchiseStoreCount: 0, similarIndustryStoreCount: 0 });
    const zeroCount = row('20251', { salesCount: '0' });
    const zeroSales = row('20251', { salesAmount: '0', salesCount: '0', salesBreakdown: breakdown('0') });
    for (const zero of [zeroStores, zeroCount, zeroSales]) {
      expect(occurrences(renderText(report([zero])), '자료 부족')).toBe(baseline);
    }
  });

  it('still labels a missing provisional value as missing data', () => {
    const baseline = occurrences(renderText(report([row('20251')])), '자료 부족');
    const missing = row('20251', { similarIndustryStoreCount: null, salesCount: null });
    expect(occurrences(renderText(report([missing])), '자료 부족')).toBeGreaterThan(baseline);
  });

  // 전분기 비교 문장도 같은 규칙이다. 전분기 분모가 0이라 값이 없으면 전분기 값이 없다고 쓰지 않는다.
  // 기본 행의 점포당 월매출은 30,000,000 ÷ 10 = 300만 원, 평균 금액은 30,000,000 ÷ 1,500 = 20,000원이다.
  const PER_STORE = '점포당 월매출(잠정)은 300만 원이에요.';
  const AVERAGE = '결제 1건당 평균 금액은 20,000원이에요.';
  const zeroDenominators = { storeCount: 0, franchiseStoreCount: 0, similarIndustryStoreCount: 0, salesCount: '0' };

  it('says the previous quarter had a zero denominator instead of no value', () => {
    const text = renderText(report([row('20244', zeroDenominators), row('20251')]));
    expect(text).toContain(`${PER_STORE} 전분기는 유사 업종 점포 수가 0개라 비교하지 않았어요`);
    expect(text).toContain(`${AVERAGE} 전분기는 매출 건수가 0건이라 비교하지 않았어요`);
  });

  it('still says a missing previous value is missing in the ratio sentences', () => {
    const previous = row('20244', { similarIndustryStoreCount: null, salesCount: null });
    const text = renderText(report([previous, row('20251')]));
    expect(text).toContain(`${PER_STORE} 전분기 값이 없어`);
    expect(text).toContain(`${AVERAGE} 전분기 값이 없어`);
  });

  it('calls the previous value missing when its sales value is missing, even with a zero denominator', () => {
    const previous = row('20244', { ...zeroDenominators, salesAmount: null, salesStatus: 'NOT_PROVIDED' });
    const text = renderText(report([previous, row('20251')]));
    expect(text).toContain(`${PER_STORE} 전분기 값이 없어`);
    expect(text).toContain(`${AVERAGE} 전분기 값이 없어`);
  });

  // '전분기'는 바로 앞 분기다. 적재기는 자료가 있는 분기에만 행을 만들므로 행이 빠진 분기를 건너뛰어 비교하지 않는다.
  it('does not compare with an older row when the previous quarter has no row', () => {
    const ratios = renderText(report([row('20243', zeroDenominators), row('20251')]));
    expect(ratios).toContain(`${PER_STORE} 전분기 값이 없어`);
    expect(ratios).toContain(`${AVERAGE} 전분기 값이 없어`);

    const stores = renderText(report([row('20243'), row('20251', { similarIndustryStoreCount: 12 })]));
    expect(stores).toContain('는 12개예요. 전분기 값이 없어');
  });

  it('still compares with the previous quarter when it has a row', () => {
    // 12 − 10 = 2개, 2 ÷ 10 = 20.0%
    const text = renderText(report([row('20244'), row('20251', { similarIndustryStoreCount: 12 })]));
    expect(text).toContain('는 12개예요. 전분기 대비 2개(+20.0%) 늘었어요');
  });

  // 원값이 없을 때는 원값이 없다고만 쓴다. 관측된 분모 0까지 '없을 수 있다'고 읽히게 쓰지 않는다.
  it('names the missing sales value alone when the denominator is an observed zero', () => {
    const text = renderText(
      report([
        row('20251', {
          salesAmount: null,
          salesStatus: 'NOT_PROVIDED',
          salesCount: '0',
          storeCount: 0,
          franchiseStoreCount: 0,
          similarIndustryStoreCount: 0,
        }),
      ]),
    );
    expect(text).toContain('매출 원값이 없어');
    expect(text).not.toContain('점포 수가 없어');
    expect(text).not.toContain('건수가 없어');
  });

  it('writes a missing store count without a unit suffix', () => {
    const text = renderText(report([row('20251', { openedStoreCount: null, closedStoreCount: null })]));
    expect(text).not.toContain('자료 부족개');
  });

  // 말풍선·스크린 리더 문구에서 요일 '월'과 값이 이어져 '월매출'로 읽히지 않아야 한다.
  // 스크린 리더는 쌍점을 읽지 않을 수 있어 요일을 온전히 쓴다.
  it('keeps a zero-total share tooltip from reading as monthly sales', () => {
    const html = renderHtml(report([row('20251', { salesAmount: '0', salesBreakdown: breakdown('0') })]));
    expect(html).toContain('aria-label="월요일: 매출 0원"');
    expect(html).not.toMatch(/aria-label="월\s*매출/);
  });
});

function breakdown(amount: string): SalesBreakdown {
  const point = (key: string, label: string) => ({ key, label, salesAmount: amount, salesCount: amount });
  return {
    schemaVersion: 'market-sales-breakdown-v1.0.0',
    dayOfWeek: [point('MON', '월'), point('TUE', '화')],
    timeOfDay: [point('11_14', '11~14시'), point('17_21', '17~21시')],
    gender: [point('MALE', '남성'), point('FEMALE', '여성')],
    age: [point('20', '20대'), point('30', '30대')],
    limitations: [],
  };
}
