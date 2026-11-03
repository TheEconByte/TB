import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../lib/checksum.ts';
import {
  CONDITION_MODEL,
  CONDITION_PROMPT_VERSION,
  MAX_EXTRACTION_TEXT_CHARS,
  extractNoticeConditions,
  verifyConditionOutput,
  type ConditionExtractionStore,
  type ConditionExtractor,
  type ConditionOutput,
} from './notice-extraction.ts';

// ADR 0009 §3·Validation: AI가 읽은 값은 원문 인용이 본문에 그대로 있을 때만 쓴다. 실제 AI는 부르지 않는다.

const BODY = [
  '[공지 본문: 2026년 청년 창업 지원]',
  '□ 신청대상 : 서울시 소재 예비창업자 및 업력 3년 이내 소상공인',
  '□ 연령 : 공고일 기준 만 39세 이하',
  '□ 제외 : 유흥주점업, 도박·사행성 업종',
  '□ 접수기간 : 2026. 11. 2.(월) ~ 2026. 11. 20.(금)',
  '업력 제한 없음(재창업자 포함)는 별도 트랙에 해당합니다.',
].join('\n');

function notMentioned() {
  return { mentioned: false, value: null, quote: null };
}

function output(overrides: Partial<ConditionOutput> = {}): ConditionOutput {
  return {
    businessStage: { mentioned: true, value: 'BOTH', quote: '예비창업자 및 업력 3년 이내 소상공인' },
    businessAge: { mentioned: true, value: { maxYears: 3 }, quote: '업력 3년 이내' },
    age: { mentioned: true, value: { min: null, max: 39 }, quote: '만 39세 이하' },
    region: {
      mentioned: true,
      value: { scope: 'PROVINCES', provinces: ['서울'], districts: [] },
      quote: '서울시 소재',
    },
    foodBusiness: notMentioned(),
    targetGroups: { mentioned: true, value: { groups: ['YOUTH'], note: null }, quote: '2026년 청년 창업 지원' },
    applicationPeriod: {
      mentioned: true,
      value: { start: '2026-11-02', end: '2026-11-20', text: null },
      quote: '2026. 11. 2.(월) ~ 2026. 11. 20.(금)',
    },
    supportTypes: notMentioned(),
    ...overrides,
  } as ConditionOutput;
}

describe('verifyConditionOutput', () => {
  it('keeps values whose quote is in the body, ignoring spacing differences (NBSP, line breaks)', () => {
    const fields = verifyConditionOutput(output(), BODY);
    // 본문은 '만 39세'(묶음 빈칸)이고 인용은 보통 빈칸이다.
    expect(fields.age).toEqual({ status: 'READ', value: { min: null, max: 39 }, quote: '만 39세 이하' });
    expect(fields.businessAge).toMatchObject({ status: 'READ', value: { maxYears: 3 } });
    // PDF는 낱말 중간에서도 줄을 바꾼다. 빈칸과 줄바꿈을 무시하고 맞춘다.
    const wrapped = verifyConditionOutput(output(), BODY.replace('업력 3년 이내', '업\n력 3년 이­내'));
    expect(wrapped.businessAge.status).toBe('READ');
  });

  // AI가 지어낸 인용을 기계적으로 걸러 낸다.
  it('marks a value unreadable when its quote is not in the body', () => {
    const fields = verifyConditionOutput(
      output({ age: { mentioned: true, value: { min: 19, max: 34 }, quote: '만 19세 이상 34세 이하' } }),
      BODY,
    );
    expect(fields.age).toEqual({ status: 'UNREADABLE', reason: expect.stringContaining('본문에 없') });
  });

  it('does not accept a quote too short to prove anything', () => {
    const fields = verifyConditionOutput(
      output({ age: { mentioned: true, value: { min: null, max: 39 }, quote: '39세' } }),
      BODY,
    );
    expect(fields.age.status).toBe('UNREADABLE');
  });

  // §3: 본문에 조건이 없으면 "제한 없음"이 아니라 "언급 없음"이다.
  it('keeps "not mentioned" apart from an explicit "no limit"', () => {
    const fields = verifyConditionOutput(
      output({
        age: notMentioned(),
        businessAge: { mentioned: true, value: { maxYears: null }, quote: '업력 제한 없음' },
      } as Partial<ConditionOutput>),
      BODY,
    );
    expect(fields.age).toEqual({ status: 'NOT_MENTIONED' });
    expect(fields.businessAge).toEqual({ status: 'READ', value: { maxYears: null }, quote: '업력 제한 없음' });
  });

  it('marks a stated field without a value or a quote unreadable', () => {
    const fields = verifyConditionOutput(
      output({
        age: { mentioned: true, value: null, quote: '만 39세 이하' },
        region: { mentioned: true, value: { scope: 'NATIONWIDE', provinces: [], districts: [] }, quote: null },
      } as Partial<ConditionOutput>),
      BODY,
    );
    expect(fields.age.status).toBe('UNREADABLE');
    expect(fields.region.status).toBe('UNREADABLE');
  });

  it('does not keep impossible dates or ages even with a real quote', () => {
    const fields = verifyConditionOutput(
      output({
        applicationPeriod: {
          mentioned: true,
          value: { start: '2026-11-31', end: '2026-11-20', text: null },
          quote: '2026. 11. 2.(월) ~ 2026. 11. 20.(금)',
        },
        age: { mentioned: true, value: { min: null, max: 390 }, quote: '만 39세 이하' },
      }),
      BODY,
    );
    expect(fields.applicationPeriod.status).toBe('UNREADABLE');
    expect(fields.age.status).toBe('UNREADABLE');
  });
});

type Saved = Parameters<ConditionExtractionStore['save']>[0];

function memoryStore(
  texts: Record<string, string>,
  saved: Saved[] = [],
): ConditionExtractionStore & { saved: Saved[] } {
  return {
    saved,
    async text(productKey, textChecksum) {
      const text = texts[productKey];
      return text !== undefined && sha256Hex(text) === textChecksum ? text : null;
    },
    async has(productKey, textChecksum, model, promptVersion) {
      return saved.some(
        (row) =>
          row.productKey === productKey &&
          row.textChecksum === textChecksum &&
          row.model === model &&
          row.promptVersion === promptVersion,
      );
    },
    async save(row) {
      saved.push(row);
    },
  };
}

const NOW = new Date('2026-11-03T03:00:00Z');

function okExtractor(): ConditionExtractor & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ output: output(), inputTokens: 1200, outputTokens: 300 }));
}

describe('extractNoticeConditions', () => {
  const targets = [{ productKey: 'bizinfo-pbln-a', textChecksum: sha256Hex(BODY) }];

  it('stores verified fields with the model, prompt version, body checksum and token counts', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY });
    const report = await extractNoticeConditions(targets, { store, extractor: okExtractor(), now: () => NOW });
    expect(report.counts).toMatchObject({ EXTRACTED: 1 });
    expect(store.saved).toEqual([
      expect.objectContaining({
        productKey: 'bizinfo-pbln-a',
        textChecksum: sha256Hex(BODY),
        model: CONDITION_MODEL,
        promptVersion: CONDITION_PROMPT_VERSION,
        inputTokens: 1200,
        outputTokens: 300,
        extractedAt: NOW,
        rawOutput: output(),
      }),
    ]);
    expect(store.saved[0].fields.age).toMatchObject({ status: 'READ' });
  });

  // 같은 본문·프롬프트·모델이면 다시 부르지 않는다(ADR 0009 §3).
  it('does not call the AI again for the same body, prompt and model', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY });
    await extractNoticeConditions(targets, { store, extractor: okExtractor(), now: () => NOW });
    const extractor = okExtractor();
    const report = await extractNoticeConditions(targets, { store, extractor, now: () => NOW });
    expect(extractor).not.toHaveBeenCalled();
    expect(report.counts).toMatchObject({ CACHED: 1, EXTRACTED: 0 });
  });

  // 실패한 공고는 "읽지 못함"으로 두고 다음 동기화에서 다시 부른다. 다른 공고는 계속 읽는다.
  it('leaves a failed notice without a result and goes on with the others', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY, 'bizinfo-pbln-b': `${BODY}\n추가` });
    const extractor: ConditionExtractor = vi.fn(async (text: string) => {
      if (!text.includes('추가')) throw new Error('529 overloaded');
      return { output: output(), inputTokens: 1, outputTokens: 1 };
    });
    const report = await extractNoticeConditions(
      [...targets, { productKey: 'bizinfo-pbln-b', textChecksum: sha256Hex(`${BODY}\n추가`) }],
      { store, extractor, now: () => NOW },
    );
    expect(report.counts).toMatchObject({ FAILED: 1, EXTRACTED: 1 });
    expect(report.failures[0]).toContain('529 overloaded');
    expect(store.saved.map((row) => row.productKey)).toEqual(['bizinfo-pbln-b']);
  });

  it('does not call the AI without a key, and does not send bodies over the size limit', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY });
    expect((await extractNoticeConditions(targets, { store, extractor: null, now: () => NOW })).counts).toMatchObject({
      NOT_CONFIGURED: 1,
    });
    const long = 'ㄱ'.repeat(MAX_EXTRACTION_TEXT_CHARS + 1);
    const extractor = okExtractor();
    const report = await extractNoticeConditions([{ productKey: 'long', textChecksum: sha256Hex(long) }], {
      store: memoryStore({ long }),
      extractor,
      now: () => NOW,
    });
    expect(extractor).not.toHaveBeenCalled();
    expect(report.counts).toMatchObject({ TOO_LONG: 1 });
  });
});

// ADR 0009 Validation: 웹 요청 경로는 AI 클라이언트를 import하지 않는다(AGENTS.md §2).
describe('the web request path', () => {
  const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const SRC = join(APP_DIR, 'src');

  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === 'generated' ? [] : files(path);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
  }

  function imports(file: string): string[] {
    const source = readFileSync(file, 'utf8');
    const specifiers = [
      ...source.matchAll(
        /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]/g,
      ),
    ].map((match) => match[1] ?? match[2] ?? match[3]);
    return specifiers.flatMap((specifier) => {
      if (specifier.startsWith('@/')) return [join(SRC, specifier.slice(2))];
      if (specifier.startsWith('.')) return [resolve(dirname(file), specifier)];
      return [specifier];
    });
  }

  it('never reaches the Anthropic SDK or the notice extraction from app routes and pages', () => {
    const entries = files(join(SRC, 'app'));
    const seen = new Set<string>();
    const reached: string[] = [];
    const queue = [...entries];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const target of imports(file)) {
        if (target.startsWith('@anthropic-ai/')) reached.push(`${relative(APP_DIR, file)} → ${target}`);
        if (!target.startsWith(APP_DIR)) continue;
        const candidates = [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')];
        const resolved = candidates.find((candidate) => {
          try {
            return statSync(candidate).isFile();
          } catch {
            return false;
          }
        });
        if (resolved === undefined) continue;
        if (/notice-(extraction|text)\.ts$/.test(resolved))
          reached.push(`${relative(APP_DIR, file)} → ${relative(APP_DIR, resolved)}`);
        queue.push(resolved);
      }
    }
    expect(entries.length).toBeGreaterThan(0);
    expect(reached).toEqual([]);
  });
});
