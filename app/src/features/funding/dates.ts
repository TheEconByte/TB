// Catalog dates are plain ISO dates (YYYY-MM-DD) and are stored in Postgres as
// DATE. They are always handled as UTC midnight so no timezone shift can move a
// review or application deadline by one day.

export function toDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00.000Z`);
}

export function fromDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// 판정 기준일은 서버의 한국 시간 날짜로 고정한다.
export function todayInKst(now: Date = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}
