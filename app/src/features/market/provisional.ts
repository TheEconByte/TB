import Decimal from 'decimal.js';
import type { QuarterIndicatorRow } from './types.ts';

// ADR 0002: 매출 원값의 시간 단위(#3)와 점포당 분모(#12)가 공식 확정되기 전까지 쓰는
// 잠정 해석. 계산 결과(plan_results)에 저장하지 않고, 사용자 가정에 자동으로 넣지 않는다.
export const PROVISIONAL_SALES_BASIS = {
  decision: 'ADR 0002',
  statement:
    '서울시 추정매출 당월_매출_금액을 분기 월평균으로 해석한 잠정 값입니다. 시간 단위와 점포당 분모가 공식 확정되면 바뀔 수 있으며, 해석이 틀리면 약 3배 차이가 납니다.',
  sources: [
    {
      label: '서울 열린데이터광장 추정매출 데이터셋 FAQ',
      url: 'https://data.seoul.go.kr/dataList/OA-15572/F/1/datasetView.do',
    },
    {
      label: '서울시 상권분석서비스 설명자료 8쪽',
      url: 'https://culture.seoul.go.kr/culture/cmmn/file/fileDown.do?atchFileId=af365d87d23c4c5b8411d3ba236292f6&bbsId=&fileSn=2&menuNo=200051',
    },
  ],
} as const;

export type ProvisionalQuarterSales = {
  quarter: string;
  // 월매출(잠정) = 당월_매출_금액 원값. 분기 월평균으로 해석한다.
  monthlySalesAmount: string | null;
  // 점포당 월매출(잠정) = 원값 ÷ 유사_업종_점포_수. 분모가 없거나 0이면 null이다.
  perStoreMonthlySalesAmount: string | null;
  // 결제 1건당 평균 금액 = 원값 ÷ 당월_매출_건수. 같은 기간 값끼리 나누므로 시간 단위 해석과 무관하다.
  averagePaymentAmount: string | null;
};

function divideWon(amount: string, divisor: Decimal.Value): string {
  return new Decimal(amount).div(divisor).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

export function provisionalQuarterSales(
  row: Pick<QuarterIndicatorRow, 'quarter' | 'salesAmount' | 'salesCount' | 'similarIndustryStoreCount'>,
): ProvisionalQuarterSales {
  const amount = row.salesAmount;
  return {
    quarter: row.quarter,
    monthlySalesAmount: amount,
    perStoreMonthlySalesAmount:
      amount === null || row.similarIndustryStoreCount === null || row.similarIndustryStoreCount === 0
        ? null
        : divideWon(amount, row.similarIndustryStoreCount),
    averagePaymentAmount:
      amount === null || row.salesCount === null || new Decimal(row.salesCount).isZero()
        ? null
        : divideWon(amount, row.salesCount),
  };
}
