export type ParsedQuarter = { raw: string; year: number; quarter: number };

const QUARTER_PATTERN = /^(\d{4})([1-4])$/;

// Source quarter codes look like 20241 (year + quarter) and carry no separator.
export function parseQuarter(input: string): ParsedQuarter | null {
  const match = QUARTER_PATTERN.exec(input.trim());
  if (!match) return null;
  return { raw: `${match[1]}${match[2]}`, year: Number(match[1]), quarter: Number(match[2]) };
}
export function isQuarter(input: string): boolean {
  return parseQuarter(input) !== null;
}

export function quarterLabel(input: string): string {
  const parsed = parseQuarter(input);
  return parsed ? `${parsed.year}년 ${parsed.quarter}분기` : input;
}

export function compareQuarters(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function basisPeriodLabel(start: string, end: string): string {
  const from = parseQuarter(start);
  const to = parseQuarter(end);
  if (!from || !to) return `${start}~${end}`;
  if (from.year === to.year) return `${from.year}년 ${from.quarter}분기~${to.quarter}분기`;
  return `${from.year}년 ${from.quarter}분기~${to.year}년 ${to.quarter}분기`;
}

export function basisPeriodCode(start: string, end: string): string {
  const from = parseQuarter(start);
  const to = parseQuarter(end);
  return `${from?.year ?? start}Q${from?.quarter ?? 1}-${to?.year ?? end}Q${to?.quarter ?? 4}`;
}
