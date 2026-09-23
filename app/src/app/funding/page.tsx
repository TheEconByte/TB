import type { Metadata } from 'next';
import FundingMatcher from '@/features/funding/FundingMatcher';

export const metadata: Metadata = {
  title: 'TrendBench | 자금 후보',
  description: '사업단계·자치구·업종·용도를 입력해 공식 공고 기반 자금 카탈로그에서 후보와 이유를 확인합니다.',
};

export default function FundingPage() {
  return <FundingMatcher />;
}
