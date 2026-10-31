'use client';

import { useEffect, useState } from 'react';
import type { MarketScoreResponse } from './api.ts';
import { handoffFromSearch, scoreApiUrl } from './handoff.ts';

// /funding 위쪽에 넘겨받은 상권 등급을 보여 준다. 등급은 참고용이며 자금 후보 판정에 쓰지 않는다(ADR 0008).
export default function MarketGradeBanner({ onLoaded }: { readonly onLoaded?: (score: MarketScoreResponse) => void }) {
  const [score, setScore] = useState<MarketScoreResponse | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const handoff = handoffFromSearch(window.location.search);
    if (!handoff) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(scoreApiUrl(handoff), { headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error('score unavailable');
        const body = (await response.json()) as MarketScoreResponse;
        if (cancelled) return;
        setScore(body);
        onLoaded?.(body);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // 넘겨받은 참조는 처음 한 번만 읽는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (failed) {
    return (
      <div className="funding-grade" role="status">
        <strong>넘겨받은 상권 등급을 확인하지 못했습니다.</strong>
        <p>자금 후보 조회에는 영향이 없습니다.</p>
      </div>
    );
  }
  if (!score) return null;
  return (
    <div className="funding-grade" role="status" data-testid="funding-grade">
      {score.status === 'OK' && score.score ? (
        <strong>
          상권 생존점수 등급 {score.score.grade} ({score.score.value}점) · {score.area.displayName}{' '}
          {score.industry.displayName} · {score.baseQuarterLabel} 기준
        </strong>
      ) : (
        <strong>
          {score.area.displayName} {score.industry.displayName}: {score.message}
        </strong>
      )}
      <p>등급은 참고용입니다. 자금 후보 판정 조건에 쓰지 않으며, 대출 승인 가능성을 뜻하지 않습니다.</p>
    </div>
  );
}
