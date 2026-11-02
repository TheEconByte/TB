// 화면 표시용 금액 문구. API와 계산은 원 단위 정수 문자열을 그대로 쓰고, 여기서는
// 읽기 쉬운 억·만 단위 문장만 만든다.

const numberFormat = new Intl.NumberFormat('ko-KR');

const EOK = 100000000n;
const MAN = 10000n;

function joinUnits(won: bigint): string {
  const negative = won < 0n;
  let rest = negative ? -won : won;
  const eok = rest / EOK;
  rest %= EOK;
  const man = rest / MAN;
  const unit = rest % MAN;
  const parts: string[] = [];
  if (eok > 0n) parts.push(`${numberFormat.format(eok)}억`);
  if (man > 0n) parts.push(`${numberFormat.format(man)}만`);
  const endsWithUnit = unit === 0n && parts.length > 0;
  if (!endsWithUnit) parts.push(numberFormat.format(unit));
  return `${negative ? '-' : ''}${parts.join(' ')}${endsWithUnit ? ' 원' : '원'}`;
}

/** 정확한 금액을 억·만 단위로 쓴다. 예: 123456789 → "1억 2,345만 6,789원" */
export function formatKoreanWon(value: string): string {
  return joinUnits(BigInt(value));
}

/** 만 원 단위로 반올림(0.5 이상 올림)한 요약 금액. 1만 원 미만은 그대로 쓴다. */
export function formatManWon(value: string): string {
  const won = BigInt(value);
  const magnitude = won < 0n ? -won : won;
  if (magnitude < MAN) return joinUnits(won);
  const rounded = ((magnitude + MAN / 2n) / MAN) * MAN;
  return joinUnits(won < 0n ? -rounded : rounded);
}

/** 원 단위 정수 문자열을 천 단위 구분만 넣어 쓴다. */
export function formatWonExact(value: string): string {
  return `${numberFormat.format(BigInt(value))}원`;
}
