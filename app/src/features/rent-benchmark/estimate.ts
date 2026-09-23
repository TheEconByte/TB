import Decimal from 'decimal.js';

// 1평은 400/121㎡(약 3.3058㎡)다. 반올림한 3.3058을 쓰지 않고 정의값으로 환산한다.
const SQUARE_METERS_PER_PYEONG = new Decimal(400).div(121);
const WON_PER_THOUSAND = new Decimal(1000);

export type AreaInput = { value: string; unit: 'PYEONG' | 'SQUARE_METERS' };

export function areaInSquareMeters(area: AreaInput): Decimal | null {
  if (!/^\d+(?:\.\d+)?$/.test(area.value)) return null;
  const value = new Decimal(area.value);
  if (value.lessThanOrEqualTo(0)) return null;
  return area.unit === 'PYEONG' ? value.times(SQUARE_METERS_PER_PYEONG) : value;
}

// 원본은 천원/㎡ 단위의 소수다. 화면·API에는 원 단위 정수 문자열로 내보낸다.
export function wonPerSquareMeter(sourceValue: string | null): string | null {
  if (sourceValue === null) return null;
  return new Decimal(sourceValue).times(WON_PER_THOUSAND).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);
}

// 원본 ㎡당 월 임대료 × 면적. 중간 반올림 없이 원본 값으로 곱한 뒤 원 단위에서 한 번만 반올림한다.
export function monthlyRentReferenceWon(sourceValue: string | null, area: AreaInput): string | null {
  if (sourceValue === null) return null;
  const squareMeters = areaInSquareMeters(area);
  if (!squareMeters) return null;
  return new Decimal(sourceValue)
    .times(WON_PER_THOUSAND)
    .times(squareMeters)
    .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
    .toFixed(0);
}

export function squareMetersLabel(area: AreaInput): string | null {
  const squareMeters = areaInSquareMeters(area);
  return squareMeters ? squareMeters.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1) : null;
}

export function percentLabel(sourceValue: string | null): string | null {
  if (sourceValue === null) return null;
  return new Decimal(sourceValue).toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toFixed(1);
}
