import type { Metadata } from 'next';
import Link from 'next/link';
import RecentPlans from '@/features/plans/RecentPlans';

export const metadata: Metadata = {
  title: 'TrendBench',
  description: '서울 음식점·카페 창업용 상권 조회, 재무 계산, 정책자금 공고 확인.',
};

// 서비스의 첫 화면. 화면 셋으로 가는 길과, 로그인했으면 최근 계획을 보인다. 계산·판정은 각 화면에서만 한다.
// 순서는 창업자가 정하는 순서다: 자리를 보고, 돈을 계산하고, 모자란 돈을 채울 공고를 찾는다.
const STEPS = [
  {
    title: '상권',
    body: '자치구·상권·업종별 매출, 점포 수, 개폐업 추이. 일부 업종은 생존점수도 나옵니다.',
    note: '상권 전체의 관측값입니다. 내 가게 예상매출로 쓰지 마세요.',
    href: '/markets',
    link: '상권 보기',
  },
  {
    title: '재무 계획',
    body: '보증금·시설비·고정비·대출 조건을 넣으면 부족자금, 월 운영수지, 월 상환액을 계산합니다. 임대료·프랜차이즈 시세도 옆에 띄웁니다.',
    note: '시세는 입력값에 자동으로 들어가지 않습니다.',
    href: '/plans',
    link: '계획 열기',
  },
  {
    title: '자금 공고',
    body: '사업자등록 여부, 개업 연월, 자치구, 나이로 정책자금·지원사업 공고 중 조건이 안 맞는 것을 걸러 냅니다.',
    note: '조건은 AI가 공고문에서 읽은 것입니다. 신청 전에 원 공고를 확인하세요.',
    href: '/funding',
    link: '공고 보기',
  },
] as const;

export default function Home() {
  return (
    <main className="home">
      <section className="home-intro">
        <h1>서울 음식점·카페 창업 계획</h1>
        <p>상권 자료를 보고, 내 숫자로 필요자금을 계산하고, 신청할 만한 자금 공고를 추립니다.</p>
      </section>

      <div className="home-grid">
        <section className="panel home-steps" aria-label="화면 안내">
          <ol>
            {STEPS.map((step, index) => (
              <li key={step.href} className="home-step">
                <span className="home-step-index" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <h2>{step.title}</h2>
                  <p>{step.body}</p>
                  <p className="note">{step.note}</p>
                </div>
                {/* 로그인 없이 바로 쓸 수 있는 첫 단계만 기본 버튼이다. */}
                <Link className={index === 0 ? 'button primary' : 'button'} href={step.href}>
                  {step.link}
                </Link>
              </li>
            ))}
          </ol>
        </section>

        <RecentPlans />
      </div>
    </main>
  );
}
