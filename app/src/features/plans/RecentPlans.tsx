'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { formatWonText, showValue } from '@/features/finance/result-text';
import { api, type PlanDetail, type PlanSummary, type StoredResult } from '@/features/plans/client';
import { planHref } from '@/features/plans/plan-link';
import { revisionLabel } from '@/lib/revision-text';
import { authClient } from '@/lib/auth-client';

// 홈(/)에서 내 최근 계획으로 이어 가는 자리. 로그인하지 않았으면 계획 화면으로 보내기만 한다.
// 요약 숫자는 서버가 저장한 계산 결과를 그대로 옮긴다. 홈에서 다시 계산하지 않는다.

const RECENT_LIMIT = 3;

type Load<T> = { status: 'LOADING' } | { status: 'OK'; value: T } | { status: 'ERROR'; message: string };

const errorMessage = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback);

export default function RecentPlans() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending)
    return (
      <p className="loading-state" role="status">
        로그인 상태를 확인하고 있습니다.
      </p>
    );
  if (!session)
    return (
      <section className="home-account" aria-labelledby="home-account-title">
        <h2 id="home-account-title">내 계획</h2>
        <p>로그인하면 최근에 고친 계획과 마지막 계산 결과가 여기 나옵니다.</p>
        <Link className="primary-link" href="/plans">
          로그인
        </Link>
      </section>
    );
  return <RecentPlanList key={session.user.id} />;
}

function RecentPlanList() {
  const [plans, setPlans] = useState<Load<PlanSummary[]>>({ status: 'LOADING' });
  useEffect(() => {
    let cancelled = false;
    api<{ plans: PlanSummary[] }>('/api/plans')
      .then((data) => !cancelled && setPlans({ status: 'OK', value: data.plans.slice(0, RECENT_LIMIT) }))
      .catch(
        (error) =>
          !cancelled && setPlans({ status: 'ERROR', message: errorMessage(error, '계획 목록을 불러오지 못했습니다.') }),
      );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="home-account" aria-labelledby="recent-plans-title">
      <div className="home-account-heading">
        <h2 id="recent-plans-title">내 계획</h2>
        <Link className="secondary-link" href="/plans">
          새 계획
        </Link>
      </div>
      {plans.status === 'LOADING' && (
        <p className="loading-state" role="status">
          계획 목록을 불러오고 있습니다.
        </p>
      )}
      {plans.status === 'ERROR' && (
        <p className="inline-error" role="alert">
          {plans.message}
        </p>
      )}
      {plans.status === 'OK' && plans.value.length === 0 && <p className="empty-state">저장한 계획이 없습니다.</p>}
      {plans.status === 'OK' && plans.value.length > 0 && (
        <ul className="recent-plans">
          {plans.value.map((plan) => (
            <RecentPlanItem key={plan.id} plan={plan} />
          ))}
        </ul>
      )}
    </section>
  );
}

function RecentPlanItem({ plan }: { plan: PlanSummary }) {
  return (
    <li className="recent-plan">
      <div className="recent-plan-head">
        <strong>{plan.title}</strong>
        <span>
          저장 {plan.revision}회 · {new Date(plan.updatedAt).toLocaleDateString('ko-KR')} 수정
        </span>
      </div>
      {plan._count.results === 0 ? (
        <p className="recent-plan-note">아직 계산 전입니다.</p>
      ) : (
        <LatestResult planId={plan.id} />
      )}
      <Link className="link-button" href={planHref(plan.id)}>
        열기
      </Link>
    </li>
  );
}

function LatestResult({ planId }: { planId: string }) {
  const [result, setResult] = useState<Load<StoredResult>>({ status: 'LOADING' });
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const path = `/api/plans/${encodeURIComponent(planId)}`;
        const { plan } = await api<{ plan: PlanDetail }>(path);
        const latest = plan.results[0];
        if (!latest) throw new Error('저장 결과를 찾지 못했습니다.');
        const data = await api<{ result: StoredResult }>(`${path}/results/${encodeURIComponent(latest.id)}`);
        if (!cancelled) setResult({ status: 'OK', value: data.result });
      } catch (error) {
        if (!cancelled)
          setResult({ status: 'ERROR', message: errorMessage(error, '저장 결과를 불러오지 못했습니다.') });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [planId]);

  if (result.status === 'LOADING') return <p className="recent-plan-note">저장 결과를 불러오고 있습니다.</p>;
  if (result.status === 'ERROR') return <p className="recent-plan-note">{result.message}</p>;
  const { inputRevision, resultJson } = result.value;
  const base = resultJson.scenarios.find((scenario) => scenario.name === 'BASE');
  return (
    <div className="recent-plan-result">
      <p className="recent-plan-note">{revisionLabel(inputRevision)} 기준 계산 결과</p>
      <dl>
        <div>
          <dt>대출 전 부족액</dt>
          <dd>{showValue(resultJson.plannedFundingGap, formatWonText)}</dd>
        </div>
        {base && (
          <>
            <div>
              <dt>월 운영수지(기본)</dt>
              <dd>{showValue(base.monthlyOperatingBalance, formatWonText)}</dd>
            </div>
            <div>
              <dt>운영비 충당 매출(기본)</dt>
              <dd>{showValue(base.operatingBreakEvenRevenue, formatWonText)}</dd>
            </div>
          </>
        )}
      </dl>
    </div>
  );
}
