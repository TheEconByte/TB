import { describe, expect, it } from 'vitest';
import { formatKoreanWon, formatManWon, formatWonExact } from './format-won.ts';

describe('won display text', () => {
  it('keeps every won when writing 억·만 units', () => {
    expect(formatKoreanWon('100000000')).toBe('1억 원');
    expect(formatKoreanWon('30000000')).toBe('3,000만 원');
    expect(formatKoreanWon('123456789')).toBe('1억 2,345만 6,789원');
    expect(formatKoreanWon('0')).toBe('0원');
    expect(formatKoreanWon('9999')).toBe('9,999원');
  });

  it('rounds a summary to 만 원 half up', () => {
    expect(formatManWon('29623456')).toBe('2,962만 원');
    expect(formatManWon('29625000')).toBe('2,963만 원');
    expect(formatManWon('4473000000')).toBe('44억 7,300만 원');
    expect(formatManWon('68604')).toBe('7만 원');
    expect(formatManWon('6789')).toBe('6,789원');
    expect(formatManWon('-56000000')).toBe('-5,600만 원');
  });

  it('writes the exact source value with separators only', () => {
    expect(formatWonExact('184219542')).toBe('184,219,542원');
  });
});
