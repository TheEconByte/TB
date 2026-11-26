import type { Metadata } from 'next';
import SiteFooter from '@/components/SiteFooter';
import SiteHeader from '@/components/SiteHeader';
import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrendBench',
  description: '서울 음식점·카페 창업용 상권 조회, 재무 계산, 정책자금 공고 확인.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-brand-primary: 기본 버튼을 브랜드 파랑으로 채우는 것은 정한 일이다(styles/base.css의 brand-primary 주석).
    // 화면을 그려서 검사하는 디자인 린트가 이 표시로 그 결정을 읽는다.
    <html lang="ko" data-brand-primary>
      <body>
        <SiteHeader />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
