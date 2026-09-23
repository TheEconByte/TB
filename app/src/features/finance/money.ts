import Decimal from 'decimal.js';

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export const decimal = (value: string | number) => new Decimal(value);

/** 모든 원 단위 결과는 0.5원 이상 올림(ROUND_HALF_UP)으로 정수화한다. */
export const roundWon = (value: Decimal) => value.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);

export const won = (value: Decimal) => roundWon(value).toFixed(0);

export const sumMoney = (values: string[]) => values.reduce((sum, value) => sum.plus(value), decimal(0));
