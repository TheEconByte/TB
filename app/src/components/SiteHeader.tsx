'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { authClient } from '@/lib/auth-client';

// 모든 화면이 같은 머리말을 쓴다(layout.tsx). 주요 화면 목록과 계정 자리는 여기 한곳에만 둔다.
const NAV_ITEMS = [
  { href: '/markets', label: '상권' },
  { href: '/plans', label: '재무 계획' },
  { href: '/funding', label: '자금 공고' },
] as const;

// 로그인 폼은 재무 계획 화면에 있다. 그 화면에서는 폼이 이미 보이므로 머리말에 로그인 링크를 두지 않는다.
const SIGN_IN_PATH = '/plans';

export default function SiteHeader() {
  const pathname = usePathname();
  const { data: session, isPending } = authClient.useSession();
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link href="/" className="brand">
          <BrandMark />
          TrendBench
        </Link>
        <nav className="site-nav" aria-label="주요 화면">
          {NAV_ITEMS.map((item) => (
            <Link key={item.href} href={item.href} aria-current={pathname === item.href ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="account">
          {session ? (
            <>
              <span className="account-email">{session.user.email}</span>
              <button type="button" className="button small" onClick={() => void authClient.signOut()}>
                로그아웃
              </button>
            </>
          ) : (
            !isPending &&
            pathname !== SIGN_IN_PATH && (
              <Link className="button small" href={SIGN_IN_PATH}>
                로그인
              </Link>
            )
          )}
        </div>
      </div>
    </header>
  );
}

// 기준선(bench) 위로 올라가는 추세선(trend). app/icon.svg와 같은 그림이다.
function BrandMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect width="24" height="24" rx="6" fill="var(--primary)" />
      <path d="M5.5 18h13" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="m5.5 14 4-4.2 3.2 2.8 5.8-6.1"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
