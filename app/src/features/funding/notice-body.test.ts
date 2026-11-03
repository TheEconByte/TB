import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../../lib/checksum.ts';
import {
  buildNoticeText,
  normalizeNoticeText,
  noticeFileType,
  type NoticeDownload,
  type NoticePlan,
} from './notice-body.ts';
import type { NoticeFileType, NoticeTextResult } from './notice-text.ts';

// ADR 0009 §2: 공고 본문과 첨부(PDF·HWP·HWPX)를 텍스트로 바꿔 합치고, 읽지 못한 파일은 건너뛰며 기록한다.

function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

const NOTICE_URL = 'https://www.bizinfo.go.kr/web/lay1/bbs/S1T122C128/AS/74/view.do?pblancId=PBLN_TEST';
const fileUrl = (n: number) => `https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_TEST&fileSn=${n}`;

function plan(files: NoticePlan['files'], inline: NoticePlan['inline'] = []): NoticePlan {
  return { sourceUrl: NOTICE_URL, inline, files };
}

// 파일 바이트를 그대로 텍스트로 보는 가짜 추출기. 바이트 앞에 형식 표시를 붙여 둔다.
async function fakeExtract(data: Uint8Array, type: NoticeFileType): Promise<NoticeTextResult> {
  const text = new TextDecoder().decode(data);
  if (text.includes('BROKEN')) return { ok: false, reason: 'UNREADABLE', message: '손상된 파일' };
  if (text.includes('SCANNED')) return { ok: false, reason: 'NO_TEXT', message: '글자가 없습니다' };
  return { ok: true, text: `${type}:${text}` };
}

// 진짜 파일 형식의 머리말을 붙인 가짜 파일. 형식 판정은 확장자와 머리말을 함께 본다.
const PDF_MAGIC = '%PDF-1.7\n';
const pdf = (body: string) => new TextEncoder().encode(PDF_MAGIC + body);

function downloads(files: Record<string, Uint8Array | 'TRANSIENT' | 'GONE'>): NoticeDownload {
  return async (url) => {
    const file = files[url];
    if (file === undefined) throw new Error(`예상하지 못한 요청: ${url}`);
    if (file === 'TRANSIENT') return { ok: false, transient: true, message: 'HTTP 503' };
    if (file === 'GONE') return { ok: false, transient: false, message: 'HTTP 404' };
    return { ok: true, bytes: file };
  };
}

describe('normalizeNoticeText', () => {
  // PostgreSQL text·jsonb는 U+0000을 거부한다. 다른 제어 문자도 인용 대조를 흐린다.
  it('removes NUL and control characters but keeps line breaks, tabs and Korean text', () => {
    expect(normalizeNoticeText('신청\u0000대상:\u0007 소상공인\r\n대표자\t만 39세\r이하')).toBe(
      '신청대상: 소상공인\n대표자\t만 39세\n이하',
    );
  });
});

describe('noticeFileType', () => {
  it('reads PDF, HWP and HWPX only when the name and the file header agree', () => {
    expect(noticeFileType('공고문.pdf', fixture('notice-cid.pdf'))).toBe('PDF');
    expect(noticeFileType('공고문.HWP', fixture('notice.hwp'))).toBe('HWP');
    expect(noticeFileType('공고문.hwpx', fixture('notice.hwpx'))).toBe('HWPX');
    // 이름만 hwp인 PDF, 이름만 pdf인 HWP는 형식을 믿지 않는다.
    expect(noticeFileType('공고문.hwp', fixture('notice-cid.pdf'))).toBeNull();
    expect(noticeFileType('공고문.pdf', fixture('notice.hwp'))).toBeNull();
  });

  it('does not read other formats such as images or spreadsheets (§2 읽지 않는 것)', () => {
    expect(noticeFileType('신청서.xlsx', fixture('notice.hwpx'))).toBeNull();
    expect(noticeFileType('포스터.jpg', new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe('buildNoticeText', () => {
  it('joins inline source text and readable files, and records every document with its checksum', async () => {
    const print = pdf('본문출력 공고문');
    const result = await buildNoticeText(
      plan(
        [
          { kind: 'PRINT_FILE', name: '공고문.pdf', url: fileUrl(1) },
          { kind: 'ATTACHMENT', name: '신청서.xlsx', url: fileUrl(2) },
        ],
        [{ kind: 'API_SUMMARY', name: '기업마당 사업개요', url: NOTICE_URL, text: '사업 개요: 소상공인 지원' }],
      ),
      { download: downloads({ [fileUrl(1)]: print }), extract: fakeExtract },
    );
    if (result.status !== 'COMPLETE') throw new Error(result.status);
    expect(result.text).toContain('사업 개요: 소상공인 지원');
    expect(result.text).toContain('본문출력 공고문');
    expect(result.checksum).toBe(sha256Hex(result.text ?? ''));
    expect(result.documents).toEqual([
      expect.objectContaining({ kind: 'API_SUMMARY', url: NOTICE_URL, status: 'READ' }),
      expect.objectContaining({
        kind: 'PRINT_FILE',
        url: fileUrl(1),
        fileType: 'PDF',
        checksum: sha256Hex(Buffer.from(print)),
        status: 'READ',
      }),
      // 형식이 다른 파일은 받지 않고 건너뛴 것으로 남긴다.
      expect.objectContaining({
        kind: 'ATTACHMENT',
        url: fileUrl(2),
        fileType: null,
        checksum: null,
        status: 'UNSUPPORTED_TYPE',
      }),
    ]);
  });

  it('skips files it cannot read and records why (스캔본·손상 파일)', async () => {
    const result = await buildNoticeText(
      plan([
        { kind: 'ATTACHMENT', name: '스캔.pdf', url: fileUrl(1) },
        { kind: 'ATTACHMENT', name: '손상.pdf', url: fileUrl(2) },
        { kind: 'ATTACHMENT', name: '공고.pdf', url: fileUrl(3) },
        { kind: 'ATTACHMENT', name: '삭제됨.pdf', url: fileUrl(4) },
      ]),
      {
        download: downloads({
          [fileUrl(1)]: pdf('SCANNED'),
          [fileUrl(2)]: pdf('BROKEN'),
          [fileUrl(3)]: pdf('업력 3년 이내'),
          [fileUrl(4)]: 'GONE',
        }),
        extract: fakeExtract,
      },
    );
    if (result.status !== 'COMPLETE') throw new Error(result.status);
    expect(result.text).toContain('업력 3년 이내');
    expect(result.text).not.toContain('SCANNED');
    expect(result.documents.map((document) => document.status)).toEqual([
      'NO_TEXT',
      'UNREADABLE',
      'READ',
      'DOWNLOAD_FAILED',
    ]);
  });

  it('reads a file attached twice only once', async () => {
    const same = pdf('같은 공고문');
    const result = await buildNoticeText(
      plan([
        { kind: 'PRINT_FILE', name: '공고문.pdf', url: fileUrl(1) },
        { kind: 'ATTACHMENT', name: '공고문.pdf', url: fileUrl(2) },
      ]),
      { download: downloads({ [fileUrl(1)]: same, [fileUrl(2)]: same }), extract: fakeExtract },
    );
    if (result.status !== 'COMPLETE') throw new Error(result.status);
    expect(result.text?.match(/같은 공고문/g)).toHaveLength(1);
    expect(result.documents.map((document) => document.status)).toEqual(['READ', 'DUPLICATE']);
  });

  // 읽을 것이 없는 공고를 빈 본문으로 저장하지 않는다(AGENTS.md §3 2번). 조건은 "읽지 못함"이 된다.
  it('returns no text when nothing could be read', async () => {
    const result = await buildNoticeText(plan([{ kind: 'ATTACHMENT', name: '스캔.pdf', url: fileUrl(1) }]), {
      download: downloads({ [fileUrl(1)]: pdf('SCANNED') }),
      extract: fakeExtract,
    });
    expect(result).toMatchObject({ status: 'COMPLETE', text: null, checksum: null });
  });

  // 일시 장애로 파일 하나를 못 받았을 때 그 파일이 빠진 본문을 새 본문으로 삼으면, 다음 날 원래 본문으로 돌아올
  // 때까지 일부만 읽은 조건이 화면에 나간다.
  it('reports an incomplete body instead of a partial text when a download fails transiently', async () => {
    const result = await buildNoticeText(
      plan([
        { kind: 'PRINT_FILE', name: '공고문.pdf', url: fileUrl(1) },
        { kind: 'ATTACHMENT', name: '별표.pdf', url: fileUrl(2) },
      ]),
      { download: downloads({ [fileUrl(1)]: pdf('본문'), [fileUrl(2)]: 'TRANSIENT' }), extract: fakeExtract },
    );
    expect(result).toEqual({ status: 'INCOMPLETE', reason: expect.stringContaining('HTTP 503') });
  });

  it('gives the same text and checksum for the same documents', async () => {
    const files = { [fileUrl(1)]: pdf('본문') };
    const options = { download: downloads(files), extract: fakeExtract };
    const first = await buildNoticeText(plan([{ kind: 'PRINT_FILE', name: '공고문.pdf', url: fileUrl(1) }]), options);
    const second = await buildNoticeText(plan([{ kind: 'PRINT_FILE', name: '공고문.pdf', url: fileUrl(1) }]), options);
    expect(second).toEqual(first);
  });
});
