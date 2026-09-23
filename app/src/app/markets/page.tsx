import type { Metadata } from 'next';
import MarketExplorer from '@/features/market/MarketExplorer';

export const metadata: Metadata = {
  title: 'TrendBench | 상권 탐색',
  description: '서울 상권의 공개 지표를 자치구·상권·업종 순으로 조회합니다. 로그인 없이 사용할 수 있습니다.',
};

export default function MarketsPage() {
  return <MarketExplorer />;
}
