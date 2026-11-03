import type { PrismaClient } from '../../generated/prisma/client.ts';
import { canonicalJson } from './canonical.ts';
import { sha256Hex } from '../../lib/checksum.ts';
import {
  buildNoticeText,
  isSettledNoticeText,
  normalizeNoticeText,
  type NoticeDocumentRecord,
  type NoticeDownload,
  type NoticeExtract,
  type NoticePlan,
} from './notice-body.ts';

// funding:sync가 상품마다 본문 텍스트를 정하고 funding_notice_texts에 남긴다(ADR 0009 §2).
// 돌려준 textChecksum을 상품 버전에 적으며, ACTIVE 릴리스의 상품 버전이 가리키는 본문이 그 상품의 지금 본문이다.

export type NoticeTextRow = {
  productKey: string;
  sourceUrl: string;
  text: string;
  textChecksum: string;
  documents: NoticeDocumentRecord[];
  retrievedAt: Date;
};

export type NoticeTextStore = {
  find(productKey: string, textChecksum: string): Promise<Pick<NoticeTextRow, 'documents'> | null>;
  // 같은 productKey + textChecksum이 이미 있으면 그대로 둔다(처음 받은 시각을 지킨다).
  save(row: NoticeTextRow): Promise<void>;
};

export type NoticeTextOutcome =
  // 직전 본문과 문서 목록이 같아 파일을 받지 않고 그대로 썼다.
  | { outcome: 'REUSED'; textChecksum: string }
  | { outcome: 'STORED'; textChecksum: string }
  // 읽을 수 있는 문서가 없다. 조건은 "읽지 못함"이 된다.
  | { outcome: 'NO_TEXT'; textChecksum: null }
  // 일부 파일을 일시 장애로 받지 못했다. 직전 본문이 있으면 그것을 계속 쓴다.
  | { outcome: 'INCOMPLETE'; textChecksum: string | null; reason: string };

// 받기 전에 비교할 수 있는 문서 목록: 출처가 준 글은 내용의 checksum, 파일은 주소로 본다.
function planSignature(plan: NoticePlan): string {
  return canonicalJson([
    ...plan.inline.map((part) => ({
      kind: part.kind,
      url: part.url,
      checksum: sha256Hex(normalizeNoticeText(part.text)),
    })),
    ...plan.files.map((file) => ({ kind: file.kind, url: file.url })),
  ]);
}

function storedSignature(documents: readonly NoticeDocumentRecord[]): string {
  return canonicalJson(
    documents.map((document) =>
      document.kind === 'PRINT_FILE' || document.kind === 'ATTACHMENT'
        ? { kind: document.kind, url: document.url }
        : { kind: document.kind, url: document.url, checksum: document.checksum },
    ),
  );
}

export async function resolveNoticeText(
  input: { productKey: string; plan: NoticePlan; previousChecksum: string | null },
  deps: { store: NoticeTextStore; download: NoticeDownload; extract: NoticeExtract; now: () => Date },
): Promise<NoticeTextOutcome> {
  const { productKey, plan, previousChecksum } = input;
  if (previousChecksum !== null) {
    const previous = await deps.store.find(productKey, previousChecksum);
    // 같은 주소의 파일이 바뀌는 경우는 보지 못한다. 기업마당 변경공고는 새 파일 식별자로 올라온다.
    // 받지 못한 파일이 있던 본문은 다시 쓰지 않고 새로 읽는다.
    if (
      previous !== null &&
      isSettledNoticeText(previous.documents) &&
      storedSignature(previous.documents) === planSignature(plan)
    ) {
      return { outcome: 'REUSED', textChecksum: previousChecksum };
    }
  }
  const built = await buildNoticeText(plan, { download: deps.download, extract: deps.extract });
  if (built.status === 'INCOMPLETE') {
    return { outcome: 'INCOMPLETE', textChecksum: previousChecksum, reason: built.reason };
  }
  if (built.text === null || built.checksum === null) return { outcome: 'NO_TEXT', textChecksum: null };
  await deps.store.save({
    productKey,
    sourceUrl: plan.sourceUrl,
    text: built.text,
    textChecksum: built.checksum,
    documents: built.documents,
    retrievedAt: deps.now(),
  });
  return { outcome: 'STORED', textChecksum: built.checksum };
}

// dryRun이면 DB에 쓰지 않는다. 같은 동기화 안에서 다시 찾을 수 있게 쓴 행은 메모리에 둔다.
export function prismaNoticeTextStore(prisma: PrismaClient, options: { dryRun: boolean }): NoticeTextStore {
  const unsaved = new Map<string, NoticeTextRow>();
  return {
    async find(productKey, textChecksum) {
      const pending = unsaved.get(`${productKey}:${textChecksum}`);
      if (pending !== undefined) return pending;
      const row = await prisma.fundingNoticeText.findUnique({
        where: { productKey_textChecksum: { productKey, textChecksum } },
        select: { documents: true },
      });
      return row === null ? null : { documents: row.documents as NoticeDocumentRecord[] };
    },
    async save(row) {
      if (options.dryRun) {
        unsaved.set(`${row.productKey}:${row.textChecksum}`, row);
        return;
      }
      await prisma.fundingNoticeText.createMany({ data: [row], skipDuplicates: true });
    },
  };
}
