import { spawnSync } from 'node:child_process';
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

// 언급이 없어도 value는 채워 온다(스키마가 비울 수 없게 한다). 그 값은 쓰지 않는다.
const notMentioned = <T>(value: T) => ({ mentioned: false, value, quote: '' });
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
    foodBusiness: notMentioned(''),
    targetGroups: { mentioned: true, value: { groups: ['YOUTH'], note: null }, quote: '2026년 청년 창업 지원' },
    applicationPeriod: {
      mentioned: true,
      value: { start: '2026-11-02', end: '2026-11-20', text: null },
      // 본문은 전각 물결표 '～'다.
      quote: '2026. 11. 2.(월) ~ 2026. 11. 20.(금)',
    },
    supportTypes: notMentioned([]),
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
      output({
        age: notMentioned(upTo(null)),
        businessAge: { mentioned: true, value: upTo(null), quote: '업력 제한 없음' },
      }),
      BODY,
    );
    expect(fields.age).toEqual({ status: 'NOT_MENTIONED' });
    expect(fields.businessAge).toEqual({ status: 'READ', value: upTo(null), quote: '업력 제한 없음' });
  });

  // 구조화 출력은 value·quote를 비울 수 없어서(스키마 참고) AI는 언급이 없어도 값을 채운다. 언급 여부만 본다.
  it('ignores the value and quote of a field the notice does not mention', () => {
    const fields = verifyConditionOutput(
      output({ age: { mentioned: false, value: upTo(39), quote: '만 39세 이하' } }),
      BODY,
    );
    expect(fields.age).toEqual({ status: 'NOT_MENTIONED' });
  });

  it('marks a stated field with an empty quote or an empty choice unreadable', () => {
    const fields = verifyConditionOutput(
      output({
        region: { mentioned: true, value: output().region.value, quote: '' },
        businessStage: { mentioned: true, value: '', quote: '예비창업자 및 업력 3년 이내 소상공인' },
      }),
      BODY,
    );
    expect(fields.region).toEqual({ status: 'UNREADABLE', reason: expect.stringContaining('인용이 없') });
    expect(fields.businessStage.status).toBe('UNREADABLE');
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

  // 범위 안에 들어갈 값이 없으면 어떤 사용자도 맞지 않는다. 잘못 읽은 것으로 본다.
  it('does not keep a range no value can satisfy', () => {
    const businessAge = (value: Record<string, unknown>) =>
      verifyConditionOutput(output({ businessAge: { mentioned: true, value, quote: '업력 3년 이내' } }), BODY)
        .businessAge;
    expect(businessAge({ min: 3, max: 3, maxExclusive: true })).toMatchObject({
      status: 'UNREADABLE',
      reason: expect.stringContaining('없습니다'),
    });
    expect(businessAge({ min: null, max: 0, maxExclusive: true }).status).toBe('UNREADABLE');
    // 정확히 3년(이상이면서 이하)은 들어갈 값이 있다.
    expect(businessAge({ min: 3, max: 3, maxExclusive: false }).status).toBe('READ');
    expect(businessAge({ min: null, max: 300, maxExclusive: false })).toMatchObject({
      reason: '업력 값이 0~100 밖입니다.',
    });
  });

  it('matches a quote against full-width digits in the body', () => {
    const fields = verifyConditionOutput(output(), BODY.replace('만 39세', '만 ３９세'));
    expect(fields.age.status).toBe('READ');
  });

  // 서울이 아닌 지역의 '중구'를 서울 중구 코드로 바꾸면, 서울 중구 사용자에게 부산 공고가 맞는 공고로 보인다.
  it('maps district names to Seoul codes only when the area is Seoul', () => {
    const body = '신청대상: 부산광역시 중구 소재 소상공인\n지역: 전국(강남구 제외)\n서울특별시 소재 기업(강남구 제외)';
    const region = (value: Record<string, unknown>, quote: string) =>
      verifyConditionOutput(
        output({
          region: {
            mentioned: true,
            value: { provinces: [], districts: [], excludedProvinces: [], excludedDistricts: [], ...value },
            quote,
          },
        }),
        body,
      ).region;
    const seoulOnly = { status: 'UNREADABLE', reason: expect.stringContaining('서울') };
    // 시·도 한정에 자치구 목록이 함께 오면 어느 쪽인지 알 수 없어 읽지 못함이다(서울 코드로 바꾸지 않는다).
    expect(
      region({ scope: 'PROVINCES', provinces: ['부산'], districts: ['중구'] }, '부산광역시 중구 소재'),
    ).toMatchObject({ status: 'UNREADABLE' });
    expect(region({ scope: 'NATIONWIDE', excludedDistricts: ['강남구'] }, '전국(강남구 제외)')).toMatchObject(
      seoulOnly,
    );
    expect(
      region({ scope: 'SEOUL_DISTRICTS', provinces: ['부산'], districts: ['중구'] }, '부산광역시 중구 소재'),
    ).toMatchObject(seoulOnly);
    expect(
      region({ scope: 'PROVINCES', provinces: ['서울특별시'], excludedDistricts: ['강남구'] }, '서울특별시 소재 기업'),
    ).toMatchObject({
      status: 'READ',
      value: { provinces: ['서울'], districtCodes: [], excludedDistrictCodes: ['11680'] },
    });
  });

  it('accepts only real province names, and keeps the scope and the lists consistent', () => {
    const body = '서울특별시·부산광역시 소재 기업, 전국 대상(제주 제외)';
    const region = (value: Record<string, unknown>) =>
      verifyConditionOutput(
        output({
          region: {
            mentioned: true,
            value: { provinces: [], districts: [], excludedProvinces: [], excludedDistricts: [], ...value },
            quote: '서울특별시·부산광역시 소재 기업',
          },
        }),
        body,
      ).region;
    expect(region({ scope: 'PROVINCES', provinces: ['서울특별시', '부산시'] })).toMatchObject({
      status: 'READ',
      value: { provinces: ['서울', '부산'] },
    });
    expect(region({ scope: 'NATIONWIDE', excludedProvinces: ['제주특별자치도'] })).toMatchObject({
      status: 'READ',
      value: { excludedProvinces: ['제주'] },
    });
    expect(region({ scope: 'PROVINCES', provinces: ['서울', '아무거나'] }).status).toBe('UNREADABLE');
    expect(region({ scope: 'NATIONWIDE', excludedProvinces: ['아무거나'] }).status).toBe('UNREADABLE');
    // 전국인데 시·도 목록이 있으면 어느 쪽인지 알 수 없다.
    expect(region({ scope: 'NATIONWIDE', provinces: ['서울'] }).status).toBe('UNREADABLE');
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

  it('still counts the tokens of a successful call when saving its result fails', async () => {
    const store = memoryStore({ 'bizinfo-pbln-a': BODY });
    store.save = async () => {
      throw new Error('connection terminated');
    };
    const report = await extractNoticeConditions(targets, { store, extractor: okExtractor(), now: () => NOW });
    expect(report).toMatchObject({ counts: { FAILED: 1, EXTRACTED: 0 }, inputTokens: 1200, outputTokens: 300 });
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

  // 2026-11-04 첫 실제 동기화에서 API가 스키마를 400으로 거절했다: "too many parameters with union types ...
  // (limit: 16 parameters with unions)". 거절되면 모든 공고가 실패한다. 보내는 스키마에서 type 배열·anyOf를 센다.
  // 이 셈은 API보다 많게 나온다(거절된 스키마를 여기서는 22, API는 20으로 셌다). 그래서 16 이하면 API도 받는다.
  it('sends a schema within the API limit of 16 union-typed parameters', async () => {
    const { requests, extractor } = client({ stop_reason: 'end_turn', text: JSON.stringify(output()) });
    await extractor(BODY, '청년 창업 지원');
    const unions: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
      if (node === null || typeof node !== 'object') return;
      const schema = node as Record<string, unknown>;
      if (Array.isArray(schema.type) || 'anyOf' in schema) unions.push(path);
      for (const [key, child] of Object.entries(schema)) walk(child, `${path}.${key}`);
    };
    walk((requests[0].output_config as { format: { schema: unknown } }).format.schema, '$');
    expect(unions.length, unions.join('\n')).toBeLessThanOrEqual(16);
  });

  // 실패한 호출도 비용이 든다. 어떤 실패든 그 호출의 토큰 수를 남긴다(ADR 0009 Consequences의 비용 기록).
  it.each([
    ['the answer is cut off', 'max_tokens', '{"businessStage":', 'max_tokens'],
    ['the answer is not JSON', 'end_turn', '공고를 읽었습니다.', 'JSON이 아닙니다'],
    ['the answer does not fit the schema', 'end_turn', '{"businessStage":1}', '출력 스키마와 다릅니다'],
  ])('fails with the reason and the token counts when %s', async (_, stopReason, text, reason) => {
    const { extractor } = client({ stop_reason: stopReason, text });
    const error = await extractor(BODY, '청년 창업 지원').catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ConditionExtractionFailure);
    expect(error).toMatchObject({ message: expect.stringContaining(reason), inputTokens: 1500, outputTokens: 250 });
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

// 적재 명령은 Node가 TypeScript를 그대로 돌린다(타입만 지우는 방식). Vitest는 다른 변환기를 써서, 그 방식이 못 읽는
// 문법(생성자 매개변수 속성 등)을 써도 테스트는 통과한다. 명령을 실제로 띄워 확인한다.
describe('the funding:sync command', () => {
  it('loads under Node without a build step', () => {
    const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
    const result = spawnSync(process.execPath, ['scripts/sync-funding.ts', '--help'], {
      cwd: appDir,
      encoding: 'utf8',
    });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ANTHROPIC_API_KEY');
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

  // 맞춰 보기는 사용자 입력(장애 여부 같은 민감한 답 포함)을 다루므로 AI 클라이언트에 닿지 않아야 한다(ADR 0009 Consequences).
  // 아직 화면에 연결하지 않았어도 맞춰 보기 모듈에서 따로 출발해 확인한다.
  it('never reaches the Anthropic SDK or the notice extraction from app routes, pages and matching', () => {
    const entries = [
      ...files(join(SRC, 'app')),
      join(SRC, 'features/funding/matching.ts'),
      join(SRC, 'features/funding/match-list.ts'),
    ];
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
