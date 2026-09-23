import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrendBench | 창업 계획',
  description: '상권 지표와 나의 가정을 바탕으로 준비하는 창업 계획',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
