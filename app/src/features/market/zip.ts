import { crc32, inflateRawSync } from 'node:zlib';

export type ZipEntry = {
  name: string;
  compressionMethod: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export class ZipFormatError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_COMMENT_LENGTH = 0xffff;

function findEndOfCentralDirectory(buffer: Buffer): number {
  const lowest = Math.max(0, buffer.length - MAX_COMMENT_LENGTH - 22);
  for (let offset = buffer.length - 22; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipFormatError('ZIP 중앙 디렉터리 끝 레코드를 찾지 못했습니다.');
}
export function readCentralDirectory(buffer: Buffer, decodeName: (raw: Buffer) => string): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  const total = buffer.readUInt16LE(eocd + 10);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || directoryOffset === 0xffffffff) {
    throw new ZipFormatError('ZIP64 형식은 지원하지 않습니다.');
  }
  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < total; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipFormatError(`ZIP 중앙 디렉터리 ${index}번째 항목의 서명이 올바르지 않습니다.`);
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipFormatError('ZIP64 형식은 지원하지 않습니다.');
    }
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    entries.push({
      name: decodeName(rawName),
      compressionMethod,
      crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export function findEntry(entries: readonly ZipEntry[], extension: string): ZipEntry {
  const matches = entries.filter((entry) => entry.name.toLowerCase().endsWith(extension.toLowerCase()));
  if (matches.length === 0) throw new ZipFormatError(`ZIP 안에서 ${extension} 파일을 찾지 못했습니다.`);
  if (matches.length > 1) {
    throw new ZipFormatError(
      `ZIP 안에 ${extension} 파일이 여러 개 있습니다: ${matches.map((entry) => entry.name).join(', ')}`,
    );
  }
  return matches[0];
}

export function readEntry(buffer: Buffer, entry: ZipEntry): Buffer {
  const offset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) {
    throw new ZipFormatError(`${entry.name}의 로컬 헤더 서명이 올바르지 않습니다.`);
  }
  const nameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = buffer.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  if (entry.compressionMethod === 0) data = Buffer.from(compressed);
  else if (entry.compressionMethod === 8) data = inflateRawSync(compressed);
  else throw new ZipFormatError(`${entry.name}의 압축 방식 ${entry.compressionMethod}은(는) 지원하지 않습니다.`);
  if (data.length !== entry.uncompressedSize) {
    throw new ZipFormatError(`${entry.name}의 압축 해제 크기가 중앙 디렉터리 기록과 다릅니다.`);
  }
  if (crc32(data) !== entry.crc) {
    throw new ZipFormatError(`${entry.name}의 CRC-32가 일치하지 않습니다.`);
  }
  return data;
}

export function readZipMember(
  buffer: Buffer,
  extension: string,
  decodeName: (raw: Buffer) => string,
): { entry: ZipEntry; data: Buffer } {
  const entry = findEntry(readCentralDirectory(buffer, decodeName), extension);
  return { entry, data: readEntry(buffer, entry) };
}
