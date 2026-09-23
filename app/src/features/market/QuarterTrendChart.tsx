'use client';

export type ChartPoint = { quarter: string; label: string; shortLabel: string; amount: number | null };

const numberFormat = new Intl.NumberFormat('ko-KR');

// Dependency-free bar chart: the table next to it carries the exact values, so
// the chart only has to show the shape of the trend and where data is missing.
export default function QuarterTrendChart({ points }: { readonly points: readonly ChartPoint[] }) {
  const width = Math.max(320, points.length * 72 + 24);
  const height = 210;
  // 위쪽 여백은 최대값 라벨 줄이다. 가장 높은 막대의 값 라벨과 겹치지 않게 막대 영역 위에 둔다.
  const padding = { top: 32, right: 14, bottom: 46, left: 14 };
  const plotHeight = height - padding.top - padding.bottom;
  const observed = points.map((point) => point.amount).filter((amount): amount is number => amount !== null);
  const maximum = observed.length > 0 ? Math.max(...observed) : 0;
  const slot = (width - padding.left - padding.right) / Math.max(points.length, 1);
  const barWidth = Math.min(42, slot * 0.62);
  const described = points
    .map((point) => `${point.label} ${point.amount === null ? '자료 부족' : `${numberFormat.format(point.amount)}원`}`)
    .join(', ');

  return (
    <div className="chart-scroll">
      <svg
        className="trend-chart"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`분기별 매출 원값: ${described}`}
      >
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={width - padding.right}
          y2={height - padding.bottom}
          stroke="var(--line)"
        />
        {maximum > 0 && (
          <text x={padding.left} y={14} className="chart-max-label">
            최대 {numberFormat.format(maximum)}원
          </text>
        )}
        {points.map((point, index) => {
          const center = padding.left + slot * index + slot / 2;
          const barHeight =
            point.amount === null || maximum === 0 ? 0 : Math.max(2, (point.amount / maximum) * plotHeight);
          const y = height - padding.bottom - barHeight;
          return (
            <g key={point.quarter}>
              {point.amount === null ? (
                <rect
                  x={center - barWidth / 2}
                  y={padding.top}
                  width={barWidth}
                  height={plotHeight}
                  className="chart-missing-bar"
                />
              ) : (
                <>
                  <rect x={center - barWidth / 2} y={y} width={barWidth} height={barHeight} className="chart-bar" />
                  <text x={center} y={y - 4} className="chart-value-label">
                    {formatCompact(point.amount)}
                  </text>
                </>
              )}
              <text x={center} y={height - padding.bottom + 18} className="chart-axis-label">
                {point.shortLabel}
              </text>
              {point.amount === null && (
                <text x={center} y={height - padding.bottom + 34} className="chart-missing-label">
                  자료 부족
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
function formatCompact(amount: number): string {
  if (amount >= 100000000) return `${(amount / 100000000).toFixed(1)}억`;
  if (amount >= 10000) return `${Math.round(amount / 10000)}만`;
  return numberFormat.format(amount);
}
