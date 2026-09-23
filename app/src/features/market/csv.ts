import { TextDecoder } from 'node:util';

export class TextEncodingError extends Error {}

export function decodeCp949(buffer: Buffer, label: string): string {
  const text = new TextDecoder('euc-kr', { fatal: false }).decode(buffer);
  if (text.includes('\uFFFD')) {
    throw new TextEncodingError(`${label}을(를) CP949(euc-kr)로 해석하는 동안 알 수 없는 문자가 생겼습니다.`);
  }
  return text;
}
export function decodeDbfField(raw: Buffer, label: string): string {
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(raw)
    .replace(/\u0000/g, '')
    .trim();
  if (text.includes('\uFFFD')) {
    throw new TextEncodingError(`${label} 속성을 UTF-8로 해석하지 못했습니다.`);
  }
  return text;
}

// Minimal RFC4180 reader that tolerates the quoted, CP949 CSV files the Seoul
// dataset ships. Rows are produced one at a time so a 40MB file is never fully
// materialised as an array of rows.
export function* iterateCsvRows(text: string): Generator<string[]> {
  let field = '';
  let row: string[] = [];
  let quoted = false;
  let started = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field.length === 0) {
      quoted = true;
      started = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (character === '\n') {
      row.push(field);
      field = '';
      yield row;
      row = [];
      started = false;
    } else if (character === '\r') {
      // Part of a CRLF pair.
    } else {
      field += character;
      started = true;
    }
  }
  if (started || field.length > 0 || row.length > 0) {
    row.push(field);
    yield row;
  }
}

export function normalizeHeaderRow(row: readonly string[]): string[] {
  return row.map((cell) => (cell.charCodeAt(0) === 0xfeff ? cell.slice(1) : cell).trim());
}
