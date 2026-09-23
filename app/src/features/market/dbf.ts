import { decodeDbfField } from './csv.ts';

export type DbfField = { name: string; type: string; length: number; decimalCount: number };
export type DbfTable = { fields: DbfField[]; recordCount: number; rows: Record<string, string>[] };

export class DbfFormatError extends Error {}

const HEADER_SIZE = 32;
const FIELD_SIZE = 32;

export function parseDbf(buffer: Buffer): DbfTable {
  if (buffer.length < HEADER_SIZE + FIELD_SIZE) throw new DbfFormatError('DBF 파일이 너무 작습니다.');
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  if (headerLength < HEADER_SIZE + FIELD_SIZE + 1) throw new DbfFormatError('DBF 헤더 길이가 올바르지 않습니다.');
  if ((headerLength - 1 - HEADER_SIZE) % FIELD_SIZE !== 0) {
    throw new DbfFormatError('DBF 필드 정의 영역이 32바이트 단위가 아닙니다.');
  }
  if (buffer[headerLength - 1] !== 0x0d) throw new DbfFormatError('DBF 필드 정의 종료 바이트(0x0D)가 없습니다.');
  const fieldCount = (headerLength - 1 - HEADER_SIZE) / FIELD_SIZE;
  const fields: DbfField[] = [];
  for (let index = 0; index < fieldCount; index += 1) {
    const start = HEADER_SIZE + index * FIELD_SIZE;
    fields.push({
      name: buffer
        .subarray(start, start + 11)
        .toString('latin1')
        .split('\u0000')[0]
        .trim(),
      type: String.fromCharCode(buffer[start + 11]),
      length: buffer[start + 16],
      decimalCount: buffer[start + 17],
    });
  }
  const definedLength = fields.reduce((total, field) => total + field.length, 0) + 1;
  if (definedLength !== recordLength) {
    throw new DbfFormatError(`DBF 레코드 길이 ${recordLength}이(가) 필드 정의 합계 ${definedLength}과(와) 다릅니다.`);
  }
  const rows: Record<string, string>[] = [];
  for (let index = 0; index < recordCount; index += 1) {
    const start = headerLength + index * recordLength;
    if (start + recordLength > buffer.length) throw new DbfFormatError('DBF 레코드가 파일 길이를 넘어갑니다.');
    if (buffer[start] === 0x2a) continue;
    let cursor = start + 1;
    const row: Record<string, string> = {};
    for (const field of fields) {
      row[field.name] = decodeDbfField(buffer.subarray(cursor, cursor + field.length), `${field.name} 필드`);
      cursor += field.length;
    }
    rows.push(row);
  }
  return { fields, recordCount, rows };
}
