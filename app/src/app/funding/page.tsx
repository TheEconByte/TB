import type { Metadata } from 'next';
import FundingMatcher from '@/features/funding/FundingMatcher';

export const metadata: Metadata = {
  title: 'TrendBench | 자금 공고 맞춰 보기',
  description:
    '사업자등록 여부·개업 연월·자치구·나이·대상 한정을 입력해, AI가 공고문에서 읽은 조건과 항목마다 맞춰 봅니다.',
};

export default function FundingPage() {
  return <FundingMatcher />;
}
