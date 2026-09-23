export class MarketSourceError extends Error {
  readonly code: string;
  readonly issues: MarketIssue[] | undefined;
  readonly errorCounts: Record<string, number> | undefined;

  constructor(
    code: string,
    message: string,
    details?: { issues?: MarketIssue[]; errorCounts?: Record<string, number> },
  ) {
    super(message);
    this.name = 'MarketSourceError';
    this.code = code;
    this.issues = details?.issues;
    this.errorCounts = details?.errorCounts;
  }
}

export type MarketIssueCode =
  | 'UNEXPECTED_HEADER'
  | 'UNEXPECTED_ENCODING'
  | 'CHECKSUM_MISMATCH'
  | 'BYTE_SIZE_MISMATCH'
  | 'ROW_COUNT_MISMATCH'
  | 'MISSING_KEY'
  | 'INVALID_QUARTER'
  | 'INVALID_AREA_TYPE'
  | 'INVALID_AREA_CODE'
  | 'INVALID_INDUSTRY_CODE'
  | 'DUPLICATE_KEY'
  | 'NEGATIVE_AMOUNT'
  | 'NON_NUMERIC_AMOUNT'
  | 'NON_NUMERIC_COUNT'
  | 'UNKNOWN_AREA'
  | 'STORE_COUNT_IDENTITY'
  | 'INDUSTRY_NAME_CONFLICT'
  | 'AREA_NAME_MISMATCH'
  | 'JOIN_MISSING_STORES'
  | 'DB_VERIFICATION'
  | 'DUPLICATE_AREA'
  | 'UNEXPECTED_ROW_LENGTH'
  | 'MISSING_SUPPORTED_INDUSTRY'
  | 'AMBIGUOUS_AREA_CODE';

export type MarketIssue = { code: MarketIssueCode; source: string; detail: string; row?: number };

export type IssueCollector = {
  add(code: MarketIssueCode, source: string, detail: string, row?: number): void;
  warn(code: MarketIssueCode, source: string, detail: string, row?: number): void;
  readonly errors: MarketIssue[];
  readonly warnings: MarketIssue[];
  readonly errorCounts: Record<string, number>;
  readonly warningCounts: Record<string, number>;
  throwIfFailed(): void;
};

const MAX_DETAILS = 50;

// Collects every problem found in a source file instead of failing on the first
// row, then reports the summary counts with a bounded list of examples.
export function createIssueCollector(): IssueCollector {
  const errors: MarketIssue[] = [];
  const warnings: MarketIssue[] = [];
  const errorCounts: Record<string, number> = {};
  const warningCounts: Record<string, number> = {};

  function push(target: MarketIssue[], counts: Record<string, number>, issue: MarketIssue) {
    counts[issue.code] = (counts[issue.code] ?? 0) + 1;
    if (target.length < MAX_DETAILS) target.push(issue);
  }

  return {
    add(code, source, detail, row) {
      push(errors, errorCounts, { code, source, detail, ...(row === undefined ? {} : { row }) });
    },
    warn(code, source, detail, row) {
      push(warnings, warningCounts, { code, source, detail, ...(row === undefined ? {} : { row }) });
    },
    errors,
    warnings,
    errorCounts,
    warningCounts,
    throwIfFailed() {
      if (errors.length === 0) return;
      const summary = Object.entries(errorCounts)
        .map(([code, count]) => `${code} ${count}건`)
        .join(', ');
      const first = errors[0];
      throw new MarketSourceError(
        'SOURCE_VALIDATION_FAILED',
        `원본 검증에 실패했습니다: ${summary}. 첫 문제: [${first.code}] ${first.source} ${first.detail}`,
        {
          issues: [...errors],
          errorCounts: { ...errorCounts },
        },
      );
    },
  };
}

const QUARTER_PATTERN = /^\d{4}[1-4]$/;
const AREA_CODE_PATTERN = /^\d{7}$/;
const DISTRICT_CODE_PATTERN = /^\d{5}$/;
const INDUSTRY_CODE_PATTERN = /^[A-Z]{2}\d{6}$/;
const AMOUNT_PATTERN = /^\d+$/;
const COUNT_PATTERN = /^\d+$/;

export function isQuarterCode(value: string): boolean {
  return QUARTER_PATTERN.test(value);
}

export function isAreaCode(value: string): boolean {
  return AREA_CODE_PATTERN.test(value);
}

export function isDistrictCode(value: string): boolean {
  return DISTRICT_CODE_PATTERN.test(value);
}

export function isIndustryCode(value: string): boolean {
  return INDUSTRY_CODE_PATTERN.test(value);
}

// Source amounts are non-negative integer strings. Negative values are reported
// rather than quietly clamped, and the integer string is kept intact so no
// precision is lost on the way to NUMERIC(18,0).
export function parseAmountCell(
  value: string,
): { ok: true; amount: string } | { ok: false; reason: 'NON_NUMERIC_AMOUNT' | 'NEGATIVE_AMOUNT' } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'NON_NUMERIC_AMOUNT' };
  if (trimmed.startsWith('-')) return { ok: false, reason: 'NEGATIVE_AMOUNT' };
  if (!AMOUNT_PATTERN.test(trimmed)) return { ok: false, reason: 'NON_NUMERIC_AMOUNT' };
  return { ok: true, amount: trimmed.replace(/^0+(?=\d)/, '') };
}

export function parseCountCell(
  value: string,
): { ok: true; count: number } | { ok: false; reason: 'NON_NUMERIC_COUNT' | 'NEGATIVE_AMOUNT' } {
  const trimmed = value.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'NON_NUMERIC_COUNT' };
  if (trimmed.startsWith('-')) return { ok: false, reason: 'NEGATIVE_AMOUNT' };
  if (!COUNT_PATTERN.test(trimmed)) return { ok: false, reason: 'NON_NUMERIC_COUNT' };
  const count = Number(trimmed);
  if (!Number.isSafeInteger(count)) return { ok: false, reason: 'NON_NUMERIC_COUNT' };
  return { ok: true, count };
}
