import type { Metadata } from 'next';
import TrendBenchApp from '@/features/plans/TrendBenchApp';

export const metadata: Metadata = {
  title: 'TrendBench | 재무 계획',
  description: '사업 조건과 내 재무 가정으로 필요자금·운영수지·상환 부담을 계산하고 결과를 저장합니다.',
};

export default function PlansPage() {
  return <TrendBenchApp />;
}
