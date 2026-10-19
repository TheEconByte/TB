'use client';

// 의존성 없는 보고서 차트. 정확한 값은 보고서 아래 원본 지표 표에 있으므로 차트는
// 추세의 모양과 자료가 없는 칸만 보여 주고, 값은 강조한 칸과 마우스·키보드 초점의
// 말풍선에만 적는다.

export type ChartDatum = { key: string; label: string; value: number | null };

type Highlight = 'last' | 'max' | 'none';

function highlightKey(points: readonly ChartDatum[], highlight: Highlight): string | null {
  const observed = points.filter((point): point is ChartDatum & { value: number } => point.value !== null);
  if (observed.length === 0 || highlight === 'none') return null;
  if (highlight === 'last') return observed.at(-1)!.key;
  return observed.reduce((best, point) => (point.value > best.value ? point : best)).key;
}

function tip(point: ChartDatum, format: (value: number) => string): string {
  return `${point.label} ${point.value === null ? '자료 부족' : format(point.value)}`;
}

export function ColumnChart({
  title,
  points,
  format,
  highlight = 'last',
}: Readonly<{
  title: string;
  points: readonly ChartDatum[];
  format: (value: number) => string;
  highlight?: Highlight;
}>) {
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const maximum = values.length > 0 ? Math.max(...values) : 0;
  const strong = highlightKey(points, highlight);
  return (
    <figure className="report-chart" role="group" aria-label={title}>
      <div className="column-plot">
        {points.map((point) => {
          const percent = point.value === null || maximum === 0 ? 0 : Math.max(1.5, (point.value / maximum) * 100);
          const text = tip(point, format);
          return (
            <div key={point.key} className="column-slot" tabIndex={0} aria-label={text} data-tip={text}>
              {point.value === null ? (
                <span className="column-missing">자료 부족</span>
              ) : (
                <span
                  className={`column-bar${point.key === strong ? ' strong' : ''}`}
                  style={{ height: `${percent}%` }}
                />
              )}
              {point.key === strong && point.value !== null && (
                <span className="column-value" style={{ bottom: `calc(${percent}% + 6px)` }}>
                  {format(point.value)}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="chart-axis" aria-hidden="true">
        {points.map((point) => (
          <span key={point.key}>{point.label}</span>
        ))}
      </div>
    </figure>
  );
}

export function LineChart({
  title,
  points,
  format,
}: Readonly<{ title: string; points: readonly ChartDatum[]; format: (value: number) => string }>) {
  const values = points.flatMap((point) => (point.value === null ? [] : [point.value]));
  const low = values.length > 0 ? Math.min(...values) : 0;
  const high = values.length > 0 ? Math.max(...values) : 0;
  // 기준선이 0이 아니다. 작은 변화가 크게 보이지 않도록 세로 폭을 값의 20% 이상으로 잡는다.
  // 모든 점에 초점 말풍선을, 마지막 점에 값을 단다.
  const span = Math.max(high - low, high * 0.2, 1);
  const center = (high + low) / 2;
  const top = center + span * 0.65;
  const bottom = Math.max(0, center - span * 0.65);
  const x = (index: number) => ((index + 0.5) / points.length) * 100;
  const y = (value: number) => ((top - value) / (top - bottom)) * 100;
  const strong = highlightKey(points, 'last');

  // 자료가 없는 분기에서 선을 끊는다. 없는 값을 이어 그려 추세를 만들지 않는다.
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      if (current.length > 1) segments.push(current.join(' '));
      current = [];
      return;
    }
    current.push(`${x(index)},${y(point.value)}`);
  });
  if (current.length > 1) segments.push(current.join(' '));

  return (
    <figure className="report-chart" role="group" aria-label={title}>
      <div className="line-plot">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {segments.map((segment) => (
            <polyline key={segment} points={segment} className="line-path" vectorEffect="non-scaling-stroke" />
          ))}
        </svg>
        {points.map((point, index) => {
          const text = tip(point, format);
          if (point.value === null) {
            return (
              <span
                key={point.key}
                className="line-missing"
                style={{ left: `${x(index)}%` }}
                tabIndex={0}
                aria-label={text}
                data-tip={text}
              >
                자료 부족
              </span>
            );
          }
          return (
            <span
              key={point.key}
              className={`line-dot${point.key === strong ? ' strong' : ''}`}
              style={{ left: `${x(index)}%`, top: `${y(point.value)}%` }}
              tabIndex={0}
              aria-label={text}
              data-tip={text}
            >
              {point.key === strong && <span className="line-value">{format(point.value)}</span>}
            </span>
          );
        })}
      </div>
      <div className="chart-axis" aria-hidden="true">
        {points.map((point) => (
          <span key={point.key}>{point.label}</span>
        ))}
      </div>
    </figure>
  );
}

export type ShareDatum = { key: string; label: string; amount: string };

// 한 분류 안에서 금액 비중(%)을 소수 첫째 자리까지 구한다. 합계가 0이면 비중을 만들지 않는다.
export function shares(points: readonly ShareDatum[]): { key: string; label: string; percent: number | null }[] {
  const values = points.map((point) => BigInt(point.amount));
  const total = values.reduce((sum, value) => sum + value, 0n);
  return points.map((point, index) => ({
    key: point.key,
    label: point.label,
    percent: total === 0n ? null : Number((values[index] * 1000n + total / 2n) / total) / 10,
  }));
}

export function ShareBars({ title, points }: Readonly<{ title: string; points: readonly ShareDatum[] }>) {
  const rows = shares(points);
  const top = rows.reduce<(typeof rows)[number] | null>(
    (best, row) => (row.percent !== null && (best === null || row.percent > (best.percent ?? -1)) ? row : best),
    null,
  );
  return (
    <div className="share-bars" role="group" aria-label={title}>
      {rows.map((row) => (
        <div className={`share-row${row.key === top?.key ? ' strong' : ''}`} key={row.key}>
          <span>{row.label}</span>
          <div className="share-track">
            <span style={{ width: `${row.percent ?? 0}%` }} />
          </div>
          <strong>{row.percent === null ? '자료 부족' : `${row.percent.toFixed(1)}%`}</strong>
        </div>
      ))}
    </div>
  );
}
