import type { Metadata } from 'next';
import MarketExplorer from '@/features/market/MarketExplorer';

export const metadata: Metadata = {
  title: 'TrendBench | 상권',
  description: '서울 상권의 매출·점포·개폐업 지표를 자치구·상권·업종별로 봅니다.',
};

export default function MarketsPage() {
  return <MarketExplorer />;
}
