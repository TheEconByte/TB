import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 공고 본문 파일(PDF·HWP·HWPX)을 텍스트로 바꾼다(ADR 0009 2절). 적재 명령에서만 쓴다.
// 웹 요청 경로에서 import하지 않는다: 라이브러리가 크고, 외부에서 받은 파일을 다룬다.

export type NoticeFileType = 'PDF' | 'HWP' | 'HWPX';

export type NoticeTextResult =
  | { ok: true; text: string }
  // NO_TEXT: 파일은 열렸지만 글자가 없다(스캔본 PDF, 빈 문서).
  // UNREADABLE: 파일을 열지 못했다(손상, 암호, 형식 불일치, 지원하지 않는 판).
  | { ok: false; reason: 'NO_TEXT' | 'UNREADABLE'; message: string };

type TextReader = (data: Uint8Array) => Promise<string>;

const require = createRequire(import.meta.url);

export async function extractNoticeText(data: Uint8Array, type: NoticeFileType): Promise<NoticeTextResult> {
  // 라이브러리를 불러오지 못한 것은 설치 문제다. 파일을 읽지 못한 것으로 숨기지 않고 던진다.
  const read = type === 'PDF' ? await loadPdfReader() : await loadHwpReader();
  let text: string;
  try {
    text = await read(data);
  } catch (error) {
    return { ok: false, reason: 'UNREADABLE', message: errorMessage(error) };
  }
  // 줄바꿈만 LF로 맞춘다. HWP의 묶음 빈칸·고정폭 빈칸·하이픈은 U+00A0·U+2007·U+00AD로 남고, PDF는 줄 끝에서
  // 낱말 중간에도 줄바꿈이 들어간다. 인용 대조(ADR 0009 3절)에서 이 차이를 어떻게 다룰지는 4단계에서 정한다.
  text = text.replace(/\r\n?/g, '\n');
  // 글자가 없는 파일을 빈 성공으로 돌려주지 않는다(AGENTS.md §3 2번).
  if (text.trim() === '') return { ok: false, reason: 'NO_TEXT', message: '파일에 읽을 수 있는 글자가 없습니다.' };
  return { ok: true, text };
}

let pdfReader: Promise<TextReader> | undefined;

// pdf.js는 worker를 문서를 열 때, CMap을 글자를 뽑을 때에야 불러온다. 그때 실패하면 모든 PDF가 UNREADABLE이나
// NO_TEXT로 보이므로, 여기서 worker를 미리 불러 두고 CMap 파일이 있는지 확인해 설치 문제를 던진다.
function loadPdfReader(): Promise<TextReader> {
  pdfReader ??= (async () => {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // Node에는 Web Worker가 없어 pdf.js가 worker 코드를 같은 스레드에서 돌린다. 미리 불러 둔 것을 쓰게 한다.
    const worker: unknown = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    const root = dirname(require.resolve('pdfjs-dist/package.json'));
    const cMapUrl = join(root, 'cmaps') + '/';
    // 글꼴을 넣지 않은 한글 CID 글꼴은 CMap 파일이 있어야 글자로 바뀐다.
    await access(join(cMapUrl, 'UniKS-UCS2-H.bcmap'));
    return async (data: Uint8Array) => {
      const task = pdfjs.getDocument({
        // pdf.js가 버퍼를 넘겨받아 떼어 갈 수 있으므로 복사본을 준다.
        data: new Uint8Array(data),
        cMapUrl,
        cMapPacked: true,
        standardFontDataUrl: join(root, 'standard_fonts') + '/',
        useSystemFonts: false,
        verbosity: pdfjs.VerbosityLevel.ERRORS,
      });
      try {
        const pdf = await task.promise;
        const pages: string[] = [];
        for (let number = 1; number <= pdf.numPages; number++) {
          const page = await pdf.getPage(number);
          const content = await page.getTextContent();
          pages.push(content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''));
        }
        return pages.join('\n');
      } finally {
        await task.destroy();
      }
    };
  })();
  return pdfReader;
}

let hwpReader: Promise<TextReader> | undefined;

// rhwp는 WASM을 한 번만 초기화한다. HWP 5.0과 HWPX를 파일 내용으로 구별해 읽는다.
function loadHwpReader(): Promise<TextReader> {
  hwpReader ??= (async () => {
    const { initSync, HwpDocument } = await import('@rhwp/core');
    initSync({ module: await readFile(require.resolve('@rhwp/core/rhwp_bg.wasm')) });
    return async (data: Uint8Array) => {
      const document = new HwpDocument(data);
      try {
        // 한컴 GetTextFile("UNICODE")처럼 본문·표 칸·글상자 글이 읽는 순서로 JSON 문자열로 온다. 표는 칸 안의
        // 문단마다 한 줄이고(빈 칸은 빈 줄) 행·칸 구분 표시가 없다. 각주·미주·머리말·꼬리말은 빠진다.
        const text: unknown = JSON.parse(document.getTextFileUnicode());
        if (typeof text !== 'string') throw new Error('rhwp가 문자열이 아닌 텍스트를 돌려주었습니다.');
        return text;
      } finally {
        document.free();
      }
    };
  })();
  return hwpReader;
}

// rhwp는 Error가 아니라 문자열을 던진다.
function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() || '알 수 없는 오류로 파일을 읽지 못했습니다.';
}
