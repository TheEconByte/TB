import type { Metadata } from 'next';
import FundingMatcher from '@/features/funding/FundingMatcher';

export const metadata: Metadata = {
  title: 'TrendBench | 자금 공고',
  description: '사업자등록 여부·개업 연월·자치구·나이로 정책자금·지원사업 공고 중 조건이 안 맞는 것을 걸러 냅니다.',
};

export default function FundingPage() {
  return <FundingMatcher />;
}
