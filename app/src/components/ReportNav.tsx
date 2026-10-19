import Link from 'next/link';

const TABS = [
  { key: 'plan', href: '/', label: '창업 비용 · 목표 매출' },
  { key: 'markets', href: '/markets', label: '상권 분석' },
  { key: 'funding', href: '/funding', label: '정책자금 추천' },
] as const;

// 보고서 화면(상권 분석·정책자금 추천)이 함께 쓰는 상단 탭. meta는 오른쪽에 두는
// 기준일 같은 짧은 문장이다.
export default function ReportNav({
  active,
  meta,
}: Readonly<{ active: (typeof TABS)[number]['key']; meta?: string | null }>) {
  return (
    <header className="report-nav">
      <div className="report-nav-inner">
        <Link href="/" className="report-brand">
          TrendBench
        </Link>
        <nav aria-label="주요 화면">
          {TABS.map((tab) => (
            <Link
              key={tab.key}
              href={tab.href}
              className={tab.key === active ? 'active' : undefined}
              aria-current={tab.key === active ? 'page' : undefined}
            >
              {tab.label}
            </Link>
          ))}
        </nav>
        {meta && <span className="report-nav-meta">{meta}</span>}
      </div>
    </header>
  );
}
