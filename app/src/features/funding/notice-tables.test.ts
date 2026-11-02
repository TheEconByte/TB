import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../generated/prisma/client.ts';
import { sha256Hex } from '../../lib/checksum.ts';

// ADR 0009 §2·§3의 저장 계약을 DB 수준에서 확인한다. 수집·추출 코드는 다음 단계에서 이 테이블을 쓴다.
const KEY_PREFIX = 'test-notice-';
const MODEL = 'claude-haiku-5-5';

// 다른 이유(연결 오류 등)로 실패해도 통과하지 않도록, 막은 제약을 오류 코드나 제약 이름으로 확인한다.
// P2002: UNIQUE 위반, P2003: 외래키 위반(Prisma 오류 코드).
async function rejectedBy(promise: Promise<unknown>, expected: { code: string } | { constraint: string }) {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error, '제약이 막아야 합니다').not.toBeNull();
  if ('code' in expected) expect((error as { code?: unknown }).code).toBe(expected.code);
  else expect(String((error as Error).message)).toContain(expected.constraint);
}

function noticeText(productKey: string, text: string, retrievedAt = new Date('2026-11-03T01:00:00Z')) {
  return {
    productKey,
    sourceUrl: 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_TEST',
    text,
    textChecksum: sha256Hex(text),
    documents: [
      {
        url: 'https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=TEST',
        fileType: 'HWP',
        checksum: sha256Hex('원 파일 바이트'),
        read: true,
      },
    ],
    retrievedAt,
  };
}

function extraction(productKey: string, text: string, overrides: Record<string, unknown> = {}) {
  return {
    productKey,
    textChecksum: sha256Hex(text),
    model: MODEL,
    promptVersion: 'funding-conditions-v1',
    fields: {
      age: { status: 'READ', value: { min: 19, max: 39 }, quote: '만 39세 이하' },
      region: { status: 'NOT_MENTIONED', value: null, quote: null },
    },
    rawOutput: { age: { min: 19, max: 39, quote: '만 39세 이하' } },
    inputTokens: 1200,
    outputTokens: 150,
    extractedAt: new Date('2026-11-03T01:05:00Z'),
    ...overrides,
  };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)('notice body text and AI extraction tables (ADR 0009)', () => {
  let client: PrismaClient | null = null;

  const db = (): PrismaClient => {
    if (!client) throw new Error('PrismaClient가 초기화되지 않았습니다.');
    return client;
  };

  async function cleanUp(): Promise<void> {
    await db().fundingConditionExtraction.deleteMany({ where: { productKey: { startsWith: KEY_PREFIX } } });
    await db().fundingNoticeText.deleteMany({ where: { productKey: { startsWith: KEY_PREFIX } } });
  }

  beforeAll(async () => {
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.TEST_DATABASE_URL }) });
    await cleanUp();
  });

  afterAll(async () => {
    await cleanUp();
    await db().$disconnect();
  });

  it('keeps the body text with its source URL, checksum, retrieval time and documents (§3-10)', async () => {
    const key = `${KEY_PREFIX}provenance`;
    const body = '신청 대상: 서울시 소재 소상공인. 대표자 만 39세 이하.';
    await db().fundingNoticeText.create({ data: noticeText(key, body) });

    const stored = await db().fundingNoticeText.findFirstOrThrow({ where: { productKey: key } });
    expect(stored.text).toBe(body);
    expect(stored.textChecksum).toBe(sha256Hex(body));
    expect(stored.sourceUrl).toContain('pblancId=PBLN_TEST');
    expect(stored.retrievedAt.toISOString()).toBe('2026-11-03T01:00:00.000Z');
    expect(stored.documents).toEqual(noticeText(key, body).documents);
  });

  it('adds a new row when the body changes and keeps the old one', async () => {
    const key = `${KEY_PREFIX}history`;
    await db().fundingNoticeText.create({ data: noticeText(key, '1차 공고 본문') });
    await db().fundingNoticeText.create({ data: noticeText(key, '2차 변경 공고 본문') });

    const rows = await db().fundingNoticeText.findMany({ where: { productKey: key } });
    expect(rows.map((row) => row.text).sort()).toEqual(['1차 공고 본문', '2차 변경 공고 본문']);
  });

  it('does not store the same body twice for one notice', async () => {
    const key = `${KEY_PREFIX}duplicate`;
    await db().fundingNoticeText.create({ data: noticeText(key, '같은 본문') });
    await rejectedBy(db().fundingNoticeText.create({ data: noticeText(key, '같은 본문') }), { code: 'P2002' });
  });

  // 캐시 키의 checksum과 인용을 검증할 텍스트가 어긋나면, 다른 본문에서 읽은 결과를 이 본문의 결과로 쓰게 된다.
  it('rejects a checksum that is not the SHA-256 of the stored text', async () => {
    const key = `${KEY_PREFIX}checksum`;
    const data = { ...noticeText(key, '실제 본문'), textChecksum: sha256Hex('다른 본문') };
    await rejectedBy(db().fundingNoticeText.create({ data }), {
      constraint: 'funding_notice_texts_textChecksum_check',
    });
  });

  it('stores per-field values with quotes, model, prompt version, body checksum and extraction time (§3)', async () => {
    const key = `${KEY_PREFIX}extraction`;
    const body = '대표자 만 39세 이하 소상공인';
    await db().fundingNoticeText.create({ data: noticeText(key, body) });
    await db().fundingConditionExtraction.create({ data: extraction(key, body) });

    const stored = await db().fundingConditionExtraction.findFirstOrThrow({
      where: { productKey: key },
      include: { noticeText: true },
    });
    expect(stored.model).toBe(MODEL);
    expect(stored.promptVersion).toBe('funding-conditions-v1');
    expect(stored.textChecksum).toBe(sha256Hex(body));
    expect(stored.extractedAt.toISOString()).toBe('2026-11-03T01:05:00.000Z');
    expect(stored.fields).toEqual(extraction(key, body).fields);
    // 인용 검증은 결과가 가리키는 바로 그 본문을 기준으로 한다.
    expect(stored.noticeText.text).toContain('만 39세 이하');
  });

  it('keeps one extraction per body checksum, prompt version and model', async () => {
    const key = `${KEY_PREFIX}cache`;
    const body = '업력 3년 이내';
    await db().fundingNoticeText.create({ data: noticeText(key, body) });
    await db().fundingConditionExtraction.create({ data: extraction(key, body) });

    await rejectedBy(db().fundingConditionExtraction.create({ data: extraction(key, body) }), { code: 'P2002' });
    // 프롬프트나 모델을 바꾸면 다시 추출해 새 결과로 남긴다(ADR 0009 Validation 운영자 확인).
    await db().fundingConditionExtraction.create({
      data: extraction(key, body, { promptVersion: 'funding-conditions-v2' }),
    });
    await db().fundingConditionExtraction.create({ data: extraction(key, body, { model: 'claude-sonnet-5-5' }) });
    expect(await db().fundingConditionExtraction.count({ where: { productKey: key } })).toBe(3);
  });

  it('rejects an extraction whose body text is not stored', async () => {
    const key = `${KEY_PREFIX}orphan`;
    await rejectedBy(db().fundingConditionExtraction.create({ data: extraction(key, '저장하지 않은 본문') }), {
      code: 'P2003',
    });
  });

  it('does not delete a body text that an extraction was verified against', async () => {
    const key = `${KEY_PREFIX}restrict`;
    const body = '예비창업자 신청 가능';
    const text = await db().fundingNoticeText.create({ data: noticeText(key, body) });
    await db().fundingConditionExtraction.create({ data: extraction(key, body) });

    await rejectedBy(db().fundingNoticeText.delete({ where: { id: text.id } }), { code: 'P2003' });
  });

  it('does not let the text an extraction was verified against be rewritten', async () => {
    const key = `${KEY_PREFIX}rewrite`;
    const body = '업력 7년 이내';
    const text = await db().fundingNoticeText.create({ data: noticeText(key, body) });
    await db().fundingConditionExtraction.create({ data: extraction(key, body) });

    const rewritten = '업력 3년 이내';
    await rejectedBy(
      db().fundingNoticeText.update({
        where: { id: text.id },
        data: { text: rewritten, textChecksum: sha256Hex(rewritten) },
      }),
      { code: 'P2003' },
    );
    // checksum을 그대로 두고 텍스트만 바꾸는 것은 CHECK가 막는다.
    await rejectedBy(db().fundingNoticeText.update({ where: { id: text.id }, data: { text: rewritten } }), {
      constraint: 'funding_notice_texts_textChecksum_check',
    });
  });
});
