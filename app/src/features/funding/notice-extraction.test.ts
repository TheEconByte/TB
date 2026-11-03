import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../lib/checksum.ts';
import {
  CONDITION_MODEL,
  CONDITION_PROMPT_VERSION,
  ConditionExtractionFailure,
  MAX_EXTRACTION_TEXT_CHARS,
  createClaudeConditionExtractor,
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
  '□ 지역 : 서울 강남구ㆍ서초구 소재 사업장(송파구 제외)',
  '□ 제외 : 유흥주점업, 도박·사행성 업종',
  '□ 접수기간 : 2026. 11. 2.(월) ～ 2026. 11. 20.(금)',
  '성장 트랙은 업력 3년 이상 소상공인이 대상입니다.',
  '업력 제한 없음(재창업자 포함)는 별도 트랙에 해당합니다.',
].join('\n');

const notMentioned = { mentioned: false, value: null, quote: null };
const upTo = (max: number | null, maxExclusive = false) => ({ min: null, max, maxExclusive });

function output(overrides: Record<string, unknown> = {}): ConditionOutput {
  return {
    businessStage: { mentioned: true, value: 'BOTH', quote: '예비창업자 및 업력 3년 이내 소상공인' },
    businessAge: { mentioned: true, value: upTo(3), quote: '업력 3년 이내' },
    age: { mentioned: true, value: upTo(39), quote: '만 39세 이하' },
    region: {
      mentioned: true,
      value: {
        scope: 'SEOUL_DISTRICTS',
        provinces: [],
        districts: ['강남구', '서초구'],
        excludedProvinces: [],
        excludedDistricts: ['송파구'],
      },
      // 본문은 'ㆍ'(한글 가운뎃점)이고 인용은 '·'다.
      quote: '서울 강남구·서초구 소재 사업장(송파구 제외)',
    },
    foodBusiness: notMentioned,
    targetGroups: { mentioned: true, value: { groups: ['YOUTH'], note: null }, quote: '2026년 청년 창업 지원' },
    applicationPeriod: {
      mentioned: true,
      value: { start: '2026-11-02', end: '2026-11-20', text: null },
      // 본문은 전각 물결표 '～'다.
      quote: '2026. 11. 2.(월) ~ 2026. 11. 20.(금)',
    },
    supportTypes: notMentioned,
    ...overrides,
  } as ConditionOutput;
}

describe('verifyConditionOutput', () => {
  it('keeps values whose quote is in the body, ignoring spacing and punctuation variants', () => {
    const fields = verifyConditionOutput(output(), BODY);
    // 본문은 '만 39세'(묶음 빈칸)이고 인용은 보통 빈칸이다.
    expect(fields.age).toEqual({ status: 'READ', value: upTo(39), quote: '만 39세 이하' });
    expect(fields.businessAge).toMatchObject({ status: 'READ', value: upTo(3) });
    expect(fields.applicationPeriod.status).toBe('READ');
    // PDF는 낱말 중간에서도 줄을 바꾼다. 빈칸과 줄바꿈을 무시하고 맞춘다.
    const wrapped = verifyConditionOutput(output(), BODY.replace('업력 3년 이내', '업\n력 3년 이­내'));
    expect(wrapped.businessAge.status).toBe('READ');
  });

  it('turns Seoul district names into district codes, including excluded ones', () => {
    const fields = verifyConditionOutput(output(), BODY);
    expect(fields.region).toMatchObject({
      status: 'READ',
      value: { scope: 'SEOUL_DISTRICTS', districtCodes: ['11680', '11650'], excludedDistrictCodes: ['11710'] },
    });
  });

  // 하한("3년 이상")과 미만·이하를 구분한다(사용자 결정 2026-11-03). 하한을 "제한 없음"으로 적으면 갓 개업한
  // 사업자도 맞음이 된다.
  it('keeps a minimum business age and whether the maximum is exclusive', () => {
    const fields = verifyConditionOutput(
      output({
        businessAge: { mentioned: true, value: { min: 3, max: null, maxExclusive: false }, quote: '업력 3년 이상' },
        age: { mentioned: true, value: upTo(40, true), quote: '만 39세 이하' },
      }),
      BODY,
    );
    expect(fields.businessAge).toMatchObject({ status: 'READ', value: { min: 3, max: null } });
    expect(fields.age).toMatchObject({ status: 'READ', value: { max: 40, maxExclusive: true } });
  });

  // AI가 지어낸 인용을 기계적으로 걸러 낸다.
  it('marks a value unreadable when its quote is not in the body', () => {
    const fields = verifyConditionOutput(
      output({
        age: { mentioned: true, value: { min: 19, max: 34, maxExclusive: false }, quote: '만 19세 이상 34세 이하' },
      }),
      BODY,
    );
    expect(fields.age).toEqual({ status: 'UNREADABLE', reason: expect.stringContaining('본문에 없') });
  });

  it('does not accept a quote too short to prove anything', () => {
    const fields = verifyConditionOutput(output({ age: { mentioned: true, value: upTo(39), quote: '39세' } }), BODY);
    expect(fields.age.status).toBe('UNREADABLE');
  });

  // §3: 본문에 조건이 없으면 "제한 없음"이 아니라 "언급 없음"이다.
  it('keeps "not mentioned" apart from an explicit "no limit"', () => {
    const fields = verifyConditionOutput(
      output({ age: notMentioned, businessAge: { mentioned: true, value: upTo(null), quote: '업력 제한 없음' } }),
      BODY,
    );
    expect(fields.age).toEqual({ status: 'NOT_MENTIONED' });
    expect(fields.businessAge).toEqual({ status: 'READ', value: upTo(null), quote: '업력 제한 없음' });
  });

  it('marks a stated field without a value or a quote unreadable', () => {
    const fields = verifyConditionOutput(
      output({
        age: { mentioned: true, value: null, quote: '만 39세 이하' },
        region: { mentioned: true, value: output().region.value, quote: null },
      }),
      BODY,
    );
    expect(fields.age.status).toBe('UNREADABLE');
    expect(fields.region.status).toBe('UNREADABLE');
  });

  // 구조화 출력이 선택지를 강제하지 않는다. 잘못된 선택지는 그 항목만 읽지 못함이고 다른 항목은 남는다.
  it('marks only the field with an unknown option unreadable', () => {
    const fields = verifyConditionOutput(
      output({
        businessStage: { mentioned: true, value: '예비창업자', quote: '예비창업자 및 업력 3년 이내 소상공인' },
        targetGroups: { mentioned: true, value: { groups: ['청년'], note: null }, quote: '2026년 청년 창업 지원' },
      }),
      BODY,
    );
    expect(fields.businessStage.status).toBe('UNREADABLE');
    expect(fields.targetGroups.status).toBe('UNREADABLE');
    expect(fields.age.status).toBe('READ');
  });

  it('does not keep values that cannot be true even with a real quote', () => {
    const quote = '2026. 11. 2.(월) ~ 2026. 11. 20.(금)';
    const cases: Array<[string, Record<string, unknown>]> = [
      [
        'impossible date',
        {
          applicationPeriod: { mentioned: true, value: { start: '2026-11-31', end: '2026-11-20', text: null }, quote },
        },
      ],
      [
        'empty period',
        { applicationPeriod: { mentioned: true, value: { start: null, end: null, text: null }, quote } },
      ],
      ['age out of range', { age: { mentioned: true, value: upTo(390), quote: '만 39세 이하' } }],
      [
        'unknown district',
        {
          region: {
            mentioned: true,
            value: { ...output().region.value, districts: ['강남'] },
            quote: '서울 강남구·서초구 소재',
          },
        },
      ],
      [
        'district scope without districts',
        {
          region: {
            mentioned: true,
            value: { ...output().region.value, districts: [] },
            quote: '서울 강남구·서초구 소재',
          },
        },
      ],
      ['empty support types', { supportTypes: { mentioned: true, value: [], quote: '2026년 청년 창업 지원' } }],
    ];
    for (const [label, overrides] of cases) {
      const fields = verifyConditionOutput(output(overrides), BODY);
      const name = Object.keys(overrides)[0] as keyof typeof fields;
      expect(fields[name].status, label).toBe('UNREADABLE');
    }
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

function okExtractor() {
  return vi.fn<ConditionExtractor>(async () => ({ output: output(), inputTokens: 1200, outputTokens: 300 }));
}

describe('extractNoticeConditions', () => {
  const targets = [{ productKey: 'bizinfo-pbln-a', name: '청년 창업 지원', textChecksum: sha256Hex(BODY) }];

  it('stores verified fields with the model, prompt version, body checksum and token counts', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY });
    const extractor = okExtractor();
    const report = await extractNoticeConditions(targets, { store, extractor, now: () => NOW });
    expect(report.counts).toMatchObject({ EXTRACTED: 1 });
    // 여러 자금을 다루는 공고에서 이 상품의 조건만 읽도록 상품 이름을 함께 보낸다.
    expect(extractor).toHaveBeenCalledWith(BODY, '청년 창업 지원');
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

  // 실패한 공고는 "읽지 못함"으로 두고 다음 동기화에서 다시 부른다. 다른 공고는 계속 읽고, 실패한 호출의 토큰도 센다.
  it('leaves a failed notice without a result, counts its tokens and goes on with the others', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY, 'bizinfo-pbln-b': `${BODY}\n추가` });
    const extractor: ConditionExtractor = async (text) => {
      if (!text.includes('추가'))
        throw new ConditionExtractionFailure('AI 응답이 끝까지 오지 않았습니다(stop_reason: max_tokens).', 900, 16000);
      return { output: output(), inputTokens: 100, outputTokens: 10 };
    };
    const report = await extractNoticeConditions(
      [...targets, { productKey: 'bizinfo-pbln-b', name: '다른 상품', textChecksum: sha256Hex(`${BODY}\n추가`) }],
      { store, extractor, now: () => NOW },
    );
    expect(report.counts).toMatchObject({ FAILED: 1, EXTRACTED: 1 });
    expect(report.failures[0]).toContain('max_tokens');
    expect(report).toMatchObject({ inputTokens: 1000, outputTokens: 16010 });
    expect(store.saved.map((row) => row.productKey)).toEqual(['bizinfo-pbln-b']);
  });

  // 적재가 끝난 뒤의 DB 오류로 동기화 명령이 실패로 끝나지 않게 한다.
  it('counts a database error as a failed notice instead of throwing', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY });
    store.has = async () => {
      throw new Error('connection terminated');
    };
    const report = await extractNoticeConditions(targets, { store, extractor: okExtractor(), now: () => NOW });
    expect(report.counts).toMatchObject({ FAILED: 1 });
    expect(report.failures[0]).toContain('connection terminated');
  });

  it('does not call the AI without a key, and does not send bodies over the size limit', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY });
    expect((await extractNoticeConditions(targets, { store, extractor: null, now: () => NOW })).counts).toMatchObject({
      NOT_CONFIGURED: 1,
    });
    const long = 'ㄱ'.repeat(MAX_EXTRACTION_TEXT_CHARS + 1);
    const extractor = okExtractor();
    const report = await extractNoticeConditions(
      [{ productKey: 'long', name: '긴 공고', textChecksum: sha256Hex(long) }],
      {
        store: memoryStore({ long }),
        extractor,
        now: () => NOW,
      },
    );
    expect(extractor).not.toHaveBeenCalled();
    expect(report.counts).toMatchObject({ TOO_LONG: 1 });
  });
});

// 실제 API 대신 가짜 fetch로 요청 모양과 응답 처리를 본다.
describe('createClaudeConditionExtractor', () => {
  function client(reply: { stop_reason: string; text: string }) {
    const requests: Array<Record<string, unknown>> = [];
    const fetch = async (_url: unknown, init?: { body?: unknown }) => {
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: CONDITION_MODEL,
          content: [{ type: 'text', text: reply.text }],
          stop_reason: reply.stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 1500, output_tokens: 250 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    return {
      requests,
      extractor: createClaudeConditionExtractor(new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 })),
    };
  }

  it('sends only the product name and the notice text with the structured output schema', async () => {
    const { requests, extractor } = client({ stop_reason: 'end_turn', text: JSON.stringify(output()) });
    const result = await extractor(BODY, '청년 창업 지원');
    expect(result).toEqual({ output: output(), inputTokens: 1500, outputTokens: 250 });
    const [request] = requests;
    expect(request.model).toBe(CONDITION_MODEL);
    expect(request.output_config).toMatchObject({ format: { type: 'json_schema' } });
    expect(request.messages).toEqual([
      { role: 'user', content: `<product>청년 창업 지원</product>\n<notice>\n${BODY}\n</notice>` },
    ]);
  });

  it('fails with the stop reason and the token counts when the answer is cut off', async () => {
    const { extractor } = client({ stop_reason: 'max_tokens', text: '{"businessStage":' });
    const error = await extractor(BODY, '청년 창업 지원').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConditionExtractionFailure);
    expect(error).toMatchObject({
      message: expect.stringContaining('max_tokens'),
      inputTokens: 1500,
      outputTokens: 250,
    });
  });

  it('accepts an answer with an unknown option and leaves it to verification', async () => {
    const answer = output({
      businessStage: { mentioned: true, value: '예비창업자', quote: '예비창업자 및 업력 3년 이내 소상공인' },
    });
    const { extractor } = client({ stop_reason: 'end_turn', text: JSON.stringify(answer) });
    const result = await extractor(BODY, '청년 창업 지원');
    expect(verifyConditionOutput(result.output, BODY).businessStage.status).toBe('UNREADABLE');
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
