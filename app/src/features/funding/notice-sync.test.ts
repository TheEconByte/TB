import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../../lib/checksum.ts';
import type { NoticeDownload, NoticeExtract, NoticePlan } from './notice-body.ts';
import { resolveNoticeText, type NoticeTextRow, type NoticeTextStore } from './notice-sync.ts';

// funding:sync가 상품마다 본문 텍스트를 정하는 규칙(ADR 0009 §2, docs/domains/funding.md).
// 상품 버전에 적힌 textChecksum이 그 상품의 지금 본문이다.

const NOTICE_URL = 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_TEST';
const FILE_URL = 'https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_TEST&fileSn=1';
const NOW = new Date('2026-11-03T02:00:00Z');

const plan: NoticePlan = {
  sourceUrl: NOTICE_URL,
  inline: [{ kind: 'API_SUMMARY', name: '기업마당 사업개요', url: NOTICE_URL, text: '소상공인 지원' }],
  files: [{ kind: 'PRINT_FILE', name: '공고문.pdf', url: FILE_URL }],
};

const pdfBytes = new TextEncoder().encode('%PDF-1.7\n대표자 만 39세 이하');
const extract: NoticeExtract = async () => ({ ok: true, text: '대표자 만 39세 이하' });

function memoryStore(rows: NoticeTextRow[] = []): NoticeTextStore & { rows: NoticeTextRow[] } {
  return {
    rows,
    async find(productKey, textChecksum) {
      return rows.find((row) => row.productKey === productKey && row.textChecksum === textChecksum) ?? null;
    },
    async save(row) {
      if (!rows.some((stored) => stored.productKey === row.productKey && stored.textChecksum === row.textChecksum)) {
        rows.push(row);
      }
    },
  };
}

function okDownload(): NoticeDownload & ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true as const, bytes: pdfBytes }));
}

describe('resolveNoticeText', () => {
  it('stores a new body text with its provenance and returns its checksum', async () => {
    const store = memoryStore();
    const result = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan, previousChecksum: null },
      { store, download: okDownload(), extract, now: () => NOW },
    );
    expect(result.outcome).toBe('STORED');
    expect(store.rows).toHaveLength(1);
    const [row] = store.rows;
    expect(result.textChecksum).toBe(row.textChecksum);
    expect(row.textChecksum).toBe(sha256Hex(row.text));
    expect(row).toMatchObject({ productKey: 'bizinfo-pbln-test', sourceUrl: NOTICE_URL, retrievedAt: NOW });
    expect(row.text).toContain('대표자 만 39세 이하');
    expect(row.documents.map((document) => document.url)).toEqual([NOTICE_URL, FILE_URL]);
  });

  // 같은 파일 주소와 같은 사업개요면 파일을 다시 받지 않는다. 기업마당 공고 수백 건의 파일을 날마다 받지 않기 위해서다.
  it('reuses the current text without downloading when the notice lists the same documents', async () => {
    const store = memoryStore();
    const first = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan, previousChecksum: null },
      { store, download: okDownload(), extract, now: () => NOW },
    );
    const download = okDownload();
    const second = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan, previousChecksum: first.textChecksum },
      { store, download, extract, now: () => NOW },
    );
    expect(second).toEqual({ outcome: 'REUSED', textChecksum: first.textChecksum });
    expect(download).not.toHaveBeenCalled();
  });

  // 기업마당 파일 주소의 downloadToken은 API 호출마다 바뀐다. 파일은 토큰 없는 주소로 알아본다.
  it('still reuses the text when only the download token changed', async () => {
    const store = memoryStore();
    const withToken = (token: string): NoticePlan => ({
      ...plan,
      files: [{ ...plan.files[0], downloadUrl: `${FILE_URL}&downloadToken=${token}` }],
    });
    const download = okDownload();
    const first = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan: withToken('a'), previousChecksum: null },
      { store, download, extract, now: () => NOW },
    );
    expect(download).toHaveBeenCalledWith(`${FILE_URL}&downloadToken=a`);
    // 저장하는 주소에는 토큰을 남기지 않는다.
    expect(JSON.stringify(store.rows[0].documents)).not.toContain('downloadToken');
    const second = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan: withToken('b'), previousChecksum: first.textChecksum },
      { store, download: okDownload(), extract, now: () => NOW },
    );
    expect(second).toEqual({ outcome: 'REUSED', textChecksum: first.textChecksum });
  });

  it('reads the notice again when a document was added or the summary changed', async () => {
    const store = memoryStore();
    const first = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan, previousChecksum: null },
      { store, download: okDownload(), extract, now: () => NOW },
    );
    const changed: NoticePlan = { ...plan, inline: [{ ...plan.inline[0], text: '소상공인 지원 (변경공고)' }] };
    const download = okDownload();
    const second = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan: changed, previousChecksum: first.textChecksum },
      { store, download, extract, now: () => NOW },
    );
    expect(download).toHaveBeenCalledTimes(1);
    expect(second.outcome).toBe('STORED');
    expect(second.textChecksum).not.toBe(first.textChecksum);
    // 이전 본문은 지우지 않는다.
    expect(store.rows).toHaveLength(2);
  });

  it('keeps the previous text when a file could not be downloaded this time', async () => {
    const store = memoryStore();
    const first = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan, previousChecksum: null },
      { store, download: okDownload(), extract, now: () => NOW },
    );
    const added: NoticePlan = {
      ...plan,
      files: [...plan.files, { kind: 'ATTACHMENT', name: '별표.pdf', url: `${FILE_URL}2` }],
    };
    const failing: NoticeDownload = async (url) =>
      url === FILE_URL ? { ok: true, bytes: pdfBytes } : { ok: false, transient: true, message: 'HTTP 503' };
    const second = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan: added, previousChecksum: first.textChecksum },
      { store, download: failing, extract, now: () => NOW },
    );
    expect(second).toEqual({
      outcome: 'INCOMPLETE',
      textChecksum: first.textChecksum,
      reason: expect.stringContaining('HTTP 503'),
    });
    expect(store.rows).toHaveLength(1);
  });

  it('leaves the notice without a text when the first collection is incomplete', async () => {
    const store = memoryStore();
    const result = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan, previousChecksum: null },
      {
        store,
        download: async () => ({ ok: false, transient: true, message: '연결 실패' }),
        extract,
        now: () => NOW,
      },
    );
    expect(result).toMatchObject({ outcome: 'INCOMPLETE', textChecksum: null });
    expect(store.rows).toHaveLength(0);
  });

  it('records no text when nothing in the notice could be read', async () => {
    const store = memoryStore();
    const result = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan: { ...plan, inline: [] }, previousChecksum: null },
      {
        store,
        download: okDownload(),
        extract: async () => ({ ok: false, reason: 'NO_TEXT', message: '스캔본' }),
        now: () => NOW,
      },
    );
    expect(result).toEqual({ outcome: 'NO_TEXT', textChecksum: null });
    expect(store.rows).toHaveLength(0);
  });

  // 본문이 A→B→A로 돌아오면 A 행을 다시 쓴다. 처음 받은 시각은 바꾸지 않는다.
  it('returns to an earlier text without storing it twice', async () => {
    const store = memoryStore();
    const a = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan, previousChecksum: null },
      { store, download: okDownload(), extract, now: () => NOW },
    );
    const changed: NoticePlan = { ...plan, inline: [{ ...plan.inline[0], text: '다른 개요' }] };
    const b = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan: changed, previousChecksum: a.textChecksum },
      { store, download: okDownload(), extract, now: () => new Date('2026-11-04T02:00:00Z') },
    );
    const back = await resolveNoticeText(
      { productKey: 'bizinfo-pbln-test', plan, previousChecksum: b.textChecksum },
      { store, download: okDownload(), extract, now: () => new Date('2026-11-05T02:00:00Z') },
    );
    expect(back.textChecksum).toBe(a.textChecksum);
    expect(store.rows).toHaveLength(2);
    expect(store.rows.find((row) => row.textChecksum === a.textChecksum)?.retrievedAt).toEqual(NOW);
  });
});
