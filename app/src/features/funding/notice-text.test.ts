import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { extractNoticeText, type NoticeFileType, type NoticeTextResult } from './notice-text.ts';

// fixture는 이 테스트를 위해 만든 공고 모양 문서다. 만든 방법과 넣은 문장은 fixtures/README.md에 있다.
function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

function expectText(result: NoticeTextResult): string {
  if (!result.ok) throw new Error(`추출 실패: ${result.reason} ${result.message}`);
  return result.text;
}

// 표의 칸이 행 순서대로 이어져야 AI가 어느 자금의 한도인지 읽을 수 있다(ADR 0008 3절).
function expectInOrder(text: string, parts: readonly string[]) {
  let from = 0;
  for (const part of parts) {
    const at = text.indexOf(part, from);
    expect(at, `"${part}"가 앞 문장 뒤에 있어야 한다`).toBeGreaterThanOrEqual(0);
    from = at + part.length;
  }
}

describe('extractNoticeText', () => {
  // 기대 문장은 fixture를 만들 때 넣은 본문과 표 칸이다(fixtures/README.md).
  const readable: Array<[NoticeFileType, string, string[]]> = [
    [
      'PDF',
      'notice.pdf',
      [
        '2026년 소상공인 정책자금 융자 공고',
        '신청대상: 업력 3년 미만 소상공인 (예비 창업자 제외)',
        '자금명',
        '대출한도',
        '대출기간',
        '혁신성장촉진자금',
        '최대 2억원',
        '5년(거치 2년 포함)',
        '일반경영안정자금',
        '최대 7천만원',
        '※ 음식점업은 신청 제외 업종이 아닙니다.',
      ],
    ],
    // 글꼴을 넣지 않은 한글 CID 글꼴은 pdf.js의 CMap 파일이 있어야 읽힌다.
    [
      'PDF',
      'notice-cid.pdf',
      [
        '청년 창업 지원사업 모집 공고',
        '접수기간: 2026. 11. 1. ~ 2026. 11. 30.',
        '지원대상',
        '만 39세 이하 청년',
        '지원금액',
        '최대 3천만원',
      ],
    ],
    [
      'HWP',
      'notice.hwp',
      [
        '2026년 서울시 소상공인 육성자금 융자 지원 공고',
        '신청대상: 서울시에 사업자등록을 한 업력 7년 미만 소상공인',
        '제외업종: 유흥주점업, 사행시설 관리 및 운영업',
        '자금명',
        '지원한도',
        '금리',
        '창업기반자금',
        '최대 1억원',
        '연 2.5% 고정',
      ],
    ],
    [
      'HWPX',
      'notice.hwpx',
      [
        '2026년 소상공인 창업 지원사업 공고',
        '신청 자격: 공고일 기준 만 39세 이하 예비 창업자',
        '구분',
        '지원 내용',
        '비고',
        '사업화 자금',
        '최대 2천만원',
        '자부담 10%',
        '교육',
        '창업 교육 40시간',
        '필수',
      ],
    ],
  ];

  it.each(readable)('%s %s의 본문과 표 칸을 읽은 순서대로 돌려준다', async (type, name, parts) => {
    const text = expectText(await extractNoticeText(fixture(name), type));
    expectInOrder(text, parts);
    // 형식마다 줄바꿈이 달라도 인용 대조(ADR 0008 3절)가 같은 기준으로 동작하도록 LF로 맞춘다.
    expect(text).not.toContain('\r');
  });

  it('같은 형식을 여러 번 읽어도 결과가 같다', async () => {
    const first = expectText(await extractNoticeText(fixture('notice.hwp'), 'HWP'));
    const second = expectText(await extractNoticeText(fixture('notice.hwp'), 'HWP'));
    expect(second).toBe(first);
  });

  it('호출자의 파일 바이트를 바꾸거나 떼어 가지 않는다', async () => {
    // 수집 단계는 추출 뒤에도 원 파일 바이트로 checksum을 남긴다(ADR 0008 2절).
    for (const [type, name] of [
      ['PDF', 'notice.pdf'],
      ['HWP', 'notice.hwp'],
    ] as const) {
      const data = fixture(name);
      const before = Buffer.from(data);
      await extractNoticeText(data, type);
      expect(data.byteLength).toBe(before.byteLength);
      expect(Buffer.from(data).equals(before)).toBe(true);
    }
  });

  it('라이브러리를 불러오지 못하면 모든 공고를 읽지 못함으로 숨기지 않고 던진다', async () => {
    // 설치 문제를 파일 문제로 돌리면 동기화가 성공한 채 모든 공고가 "읽지 못함"이 된다(AGENTS.md §3 2번).
    vi.resetModules();
    vi.doMock('@rhwp/core', () => ({
      HwpDocument: class {},
      initSync: () => {
        throw new Error('WASM을 불러오지 못했습니다');
      },
    }));
    try {
      const fresh = await import('./notice-text.ts');
      await expect(fresh.extractNoticeText(fixture('notice.hwp'), 'HWP')).rejects.toThrow('WASM을 불러오지 못했습니다');
    } finally {
      vi.doUnmock('@rhwp/core');
      vi.resetModules();
    }
  });

  describe('글자를 얻지 못하면 빈 성공이 아니라 실패를 돌려준다(AGENTS.md §3 2번)', () => {
    it.each([
      // 선만 있고 글자 층이 없는 PDF(스캔본과 같은 경우)
      ['PDF', 'no-text.pdf'],
      // 문단만 있고 글자가 없는 문서
      ['HWPX', 'empty.hwpx'],
    ] as const)('%s %s: 글자가 없으면 NO_TEXT', async (type, name) => {
      const result = await extractNoticeText(fixture(name), type);
      expect(result).toMatchObject({ ok: false, reason: 'NO_TEXT' });
    });

    const garbage = new TextEncoder().encode('이 파일은 공고문이 아닙니다');
    it.each<[string, NoticeFileType, Uint8Array]>([
      ['깨진 PDF', 'PDF', new TextEncoder().encode('%PDF-1.7\n깨진 파일')],
      ['빈 PDF', 'PDF', new Uint8Array()],
      ['깨진 HWP', 'HWP', garbage],
      ['빈 HWP', 'HWP', new Uint8Array()],
      ['깨진 HWPX', 'HWPX', garbage],
      ['앞부분만 받은 HWP', 'HWP', fixture('notice.hwp').subarray(0, 3000)],
      ['비밀번호가 걸린 HWP', 'HWP', fixture('notice-password.hwp')],
      ['HWP라고 받은 PDF', 'HWP', fixture('notice.pdf')],
      ['PDF라고 받은 HWP', 'PDF', fixture('notice.hwp')],
    ])('%s: 예외를 던지지 않고 UNREADABLE과 이유를 돌려준다', async (_label, type, data) => {
      const result = await extractNoticeText(data, type);
      expect(result).toMatchObject({ ok: false, reason: 'UNREADABLE' });
      if (!result.ok) expect(result.message.trim()).not.toBe('');
    });
  });
});
