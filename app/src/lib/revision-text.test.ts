import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { revisionLabel } from './revision-text';

// 계획의 revision(AGENTS.md 3-6)은 저장할 때마다 1씩 오른다. 화면에는 "버전 3"·"revision 3" 같은 개발 용어 대신
// 몇 번째 저장인지로 쓴다(2026-11-25 화면 점검, 화면 문구 원칙: 개발 용어를 쓰지 않는다).
describe('저장 번호 문구', () => {
  it('몇 번째 저장인지로 쓴다', () => {
    expect(revisionLabel(1)).toBe('1번째 저장');
    expect(revisionLabel(12)).toBe('12번째 저장');
  });

  it('계획 화면 파일은 저장 번호를 버전·revision으로 쓰지 않는다', () => {
    // 렌더링하지 않는 분기까지 보려고 소스를 읽는다.
    const files = [
      '../features/finance/FinancePlanner.tsx',
      '../features/plans/TrendBenchApp.tsx',
      '../features/plans/RecentPlans.tsx',
      '../features/funding/match-text.ts',
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(/버전 \$?\{/);
      expect(source, file).not.toMatch(/revision \$\{/);
    }
  });
});
