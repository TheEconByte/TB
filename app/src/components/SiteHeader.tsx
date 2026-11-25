'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

// 모든 화면이 같은 머리말을 쓴다. 주요 화면 목록은 여기 한곳에만 둔다.
const NAV_ITEMS = [
  { href: '/markets', label: '상권' },
  { href: '/plans', label: '재무 계획' },
  { href: '/funding', label: '자금 공고' },
] as const;

export default function SiteHeader({ account }: { account?: ReactNode }) {
  const pathname = usePathname();
  return (
    <header>
      <Link href="/" className="brand">
        TrendBench
      </Link>
      <div className="account-actions">
        <nav aria-label="주요 화면">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              className="link-button"
              href={item.href}
              aria-current={pathname === item.href ? 'page' : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        {account}
      </div>
    </header>
  );
}
