import { sha256Hex } from '../../lib/checksum.ts';
import type { NoticeFileType, NoticeTextResult } from './notice-text.ts';

// 공고 하나의 본문을 텍스트로 모은다(ADR 0009 §2). 출처의 페이지·API가 준 글은 그대로 쓰고, 첨부는 받아서
// PDF·HWP·HWPX만 텍스트로 바꾼다. 원 파일은 저장하지 않고 URL과 checksum만 남긴다. 적재 명령에서만 쓴다.

export type NoticeDocumentKind =
  // 기업마당 API의 사업개요 항목
  | 'API_SUMMARY'
  // 소진공 공지 상세 본문
  | 'NOTICE_PAGE'
  // 소진공 정책자금 표의 자금 행과 공통 지원자격
  | 'FUND_TABLE'
  // 기업마당 본문출력파일
  | 'PRINT_FILE'
  | 'ATTACHMENT';

// 출처가 이미 텍스트로 준 부분. checksum은 그 텍스트의 SHA-256이다.
export type NoticeInlinePart = { kind: NoticeDocumentKind; name: string; url: string; text: string };
export type NoticeFilePart = { kind: 'PRINT_FILE' | 'ATTACHMENT'; name: string; url: string };

// 수집기가 만드는 본문 계획. 파일은 아직 받지 않은 상태다.
export type NoticePlan = { sourceUrl: string; inline: NoticeInlinePart[]; files: NoticeFilePart[] };

export type NoticeDocumentStatus =
  | 'READ'
  // 앞의 파일과 바이트가 같아 다시 읽지 않았다(본문출력파일과 첨부가 같은 경우가 많다).
  | 'DUPLICATE'
  | 'NO_TEXT'
  | 'UNREADABLE'
  | 'UNSUPPORTED_TYPE'
  | 'TOO_LARGE'
  // 출처가 파일이 없다고 답했다(404 등). 다시 받아도 같다고 보고 본문은 이 파일 없이 만든다.
  | 'DOWNLOAD_FAILED';

// funding_notice_texts.documents에 남기는 문서 한 건.
export type NoticeDocumentRecord = {
  kind: NoticeDocumentKind;
  name: string;
  url: string;
  fileType: NoticeFileType | null;
  checksum: string | null;
  status: NoticeDocumentStatus;
  message: string | null;
};

// transient: 연결 실패·5xx·차단처럼 다음 동기화에서는 받을 수 있는 실패.
export type NoticeDownload = (
  url: string,
) => Promise<{ ok: true; bytes: Uint8Array } | { ok: false; transient: boolean; message: string }>;

export type NoticeExtract = (data: Uint8Array, type: NoticeFileType) => Promise<NoticeTextResult>;

export type NoticeTextBuild =
  // text가 null이면 읽을 수 있는 문서가 하나도 없었다.
  | { status: 'COMPLETE'; text: string | null; checksum: string | null; documents: NoticeDocumentRecord[] }
  // 일부 파일을 일시 장애로 받지 못했다. 일부만 읽은 본문을 새 본문으로 삼지 않는다.
  | { status: 'INCOMPLETE'; reason: string };

// 이보다 큰 파일은 읽지 않는다. 공고문은 보통 수 MB이고, 메모리를 지키려는 상한이다.
export const MAX_NOTICE_FILE_BYTES = 30 * 1024 * 1024;

const KIND_LABELS: Record<NoticeDocumentKind, string> = {
  API_SUMMARY: '사업개요',
  NOTICE_PAGE: '공지 본문',
  FUND_TABLE: '정책자금 표',
  PRINT_FILE: '본문출력파일',
  ATTACHMENT: '첨부',
};

// 줄바꿈을 LF로 맞추고 탭·줄바꿈 밖의 제어 문자를 지운다. PostgreSQL text·jsonb는 U+0000을 받지 않는다.
export function normalizeNoticeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function startsWith(data: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => data[index] === byte);
}

// 이름의 확장자와 파일 머리말이 같은 형식을 가리킬 때만 그 형식으로 읽는다.
export function noticeFileType(name: string, data: Uint8Array): NoticeFileType | null {
  const extension = /\.([a-z0-9]+)\s*$/i.exec(name)?.[1].toLowerCase();
  if (extension === 'pdf') {
    // PDF 머리말 앞에 몇 바이트가 붙은 파일도 있어 앞 1KB에서 찾는다.
    const head = new TextDecoder('latin1').decode(data.subarray(0, 1024));
    return head.includes('%PDF-') ? 'PDF' : null;
  }
  // HWP 5.0은 OLE 복합 문서, HWPX는 ZIP이다.
  if (extension === 'hwp') return startsWith(data, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) ? 'HWP' : null;
  if (extension === 'hwpx') return startsWith(data, [0x50, 0x4b, 0x03, 0x04]) ? 'HWPX' : null;
  return null;
}

function isNoticeFileName(name: string): boolean {
  return /\.(pdf|hwp|hwpx)\s*$/i.test(name);
}

export async function buildNoticeText(
  plan: NoticePlan,
  options: { download: NoticeDownload; extract: NoticeExtract },
): Promise<NoticeTextBuild> {
  const documents: NoticeDocumentRecord[] = [];
  const sections: string[] = [];
  const read = (kind: NoticeDocumentKind, name: string, text: string) => {
    sections.push(`[${KIND_LABELS[kind]}: ${name}]\n${text.trim()}`);
  };

  for (const part of plan.inline) {
    const text = normalizeNoticeText(part.text);
    const empty = text.trim() === '';
    documents.push({
      kind: part.kind,
      name: part.name,
      url: part.url,
      fileType: null,
      checksum: sha256Hex(text),
      status: empty ? 'NO_TEXT' : 'READ',
      message: null,
    });
    if (!empty) read(part.kind, part.name, text);
  }

  const seen = new Set<string>();
  for (const file of plan.files) {
    const record = { kind: file.kind, name: file.name, url: file.url, fileType: null, checksum: null, message: null };
    // 이미지·엑셀 같은 형식은 받지도 않는다.
    if (!isNoticeFileName(file.name)) {
      documents.push({ ...record, status: 'UNSUPPORTED_TYPE' });
      continue;
    }
    const downloaded = await options.download(file.url);
    if (!downloaded.ok) {
      if (downloaded.transient) {
        return { status: 'INCOMPLETE', reason: `${file.name}(${file.url})을 받지 못했습니다: ${downloaded.message}` };
      }
      documents.push({ ...record, status: 'DOWNLOAD_FAILED', message: downloaded.message });
      continue;
    }
    const bytes = downloaded.bytes;
    const checksum = sha256Hex(Buffer.from(bytes));
    if (bytes.byteLength > MAX_NOTICE_FILE_BYTES) {
      documents.push({ ...record, checksum, status: 'TOO_LARGE', message: `${bytes.byteLength}바이트` });
      continue;
    }
    if (seen.has(checksum)) {
      documents.push({ ...record, checksum, status: 'DUPLICATE' });
      continue;
    }
    seen.add(checksum);
    const fileType = noticeFileType(file.name, bytes);
    if (fileType === null) {
      documents.push({ ...record, checksum, status: 'UNSUPPORTED_TYPE', message: '확장자와 파일 형식이 다릅니다.' });
      continue;
    }
    const extracted = await options.extract(bytes, fileType);
    if (!extracted.ok) {
      documents.push({ ...record, fileType, checksum, status: extracted.reason, message: extracted.message });
      continue;
    }
    documents.push({ ...record, fileType, checksum, status: 'READ' });
    read(file.kind, file.name, normalizeNoticeText(extracted.text));
  }

  if (sections.length === 0) return { status: 'COMPLETE', text: null, checksum: null, documents };
  // 파일 이름에도 제어 문자가 있을 수 있어 합친 뒤에 한 번 더 정리한다.
  const text = normalizeNoticeText(sections.join('\n\n'));
  return { status: 'COMPLETE', text, checksum: sha256Hex(text), documents };
}
