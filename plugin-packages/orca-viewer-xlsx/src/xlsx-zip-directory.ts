import type { XlsxByteSource } from './xlsx-byte-source'
import { XLSX_LIMITS, type XlsxBudget, XlsxFailure } from './xlsx-limits'
import { hasXlsxPathControl } from './xlsx-path-characters'

export type XlsxZipPart = {
  name: string
  flags: number
  method: number
  crc: number
  compressedBytes: number
  expandedBytes: number
  localOffset: number
}

export function xlsxZipName(bytes: Uint8Array): string {
  const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  if (
    !name ||
    name.length > 512 ||
    /[\\:]/.test(name) ||
    hasXlsxPathControl(name) ||
    name.startsWith('/')
  ) {
    throw new XlsxFailure('unsupported_format')
  }
  const segments = name.replace(/\/$/, '').split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new XlsxFailure('unsupported_format')
  }
  return name
}

export async function readXlsxZipDirectory(
  source: XlsxByteSource,
  budget: XlsxBudget
): Promise<{
  parts: Map<string, XlsxZipPart>
  offset: number
}> {
  const tailOffset = Math.max(0, source.size - 65557)
  const tail = await source.read(tailOffset, source.size - tailOffset)
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let end = tail.length - 22
  while (
    end >= 0 &&
    (view.getUint32(end, true) !== 0x06054b50 ||
      end + 22 + view.getUint16(end + 20, true) !== tail.length)
  ) {
    end--
  }
  if (end < 0) {
    throw new XlsxFailure('unsupported_format')
  }
  const count = view.getUint16(end + 10, true)
  const centralBytes = view.getUint32(end + 12, true)
  const offset = view.getUint32(end + 16, true)
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== count ||
    count === 65535 ||
    centralBytes === 0xffffffff ||
    offset === 0xffffffff
  ) {
    throw new XlsxFailure('unsupported_format')
  }
  if (count > XLSX_LIMITS.parts) {
    throw new XlsxFailure('limit_exceeded')
  }
  const centralEnd = offset + centralBytes
  if (centralEnd !== tailOffset + end) {
    throw new XlsxFailure('parse_failed')
  }
  const parts = new Map<string, XlsxZipPart>()
  let position = offset
  let declaredBytes = 0
  for (let index = 0; index < count; index++) {
    await budget.checkpoint()
    if (position + 46 > centralEnd) {
      throw new XlsxFailure('parse_failed')
    }
    const header = await source.read(position, 46)
    const item = new DataView(header.buffer, header.byteOffset, header.byteLength)
    if (item.getUint32(0, true) !== 0x02014b50 || item.getUint16(34, true) !== 0) {
      throw new XlsxFailure('parse_failed')
    }
    const nameBytes = item.getUint16(28, true)
    const nextPosition =
      position + 46 + nameBytes + item.getUint16(30, true) + item.getUint16(32, true)
    if (!nameBytes || nameBytes > 2048 || nextPosition > centralEnd) {
      throw new XlsxFailure('parse_failed')
    }
    const part: XlsxZipPart = {
      name: xlsxZipName(await source.read(position + 46, nameBytes)),
      flags: item.getUint16(8, true),
      method: item.getUint16(10, true),
      crc: item.getUint32(16, true),
      compressedBytes: item.getUint32(20, true),
      expandedBytes: item.getUint32(24, true),
      localOffset: item.getUint32(42, true)
    }
    if (parts.has(part.name) || part.localOffset + 30 + nameBytes + part.compressedBytes > offset) {
      throw new XlsxFailure('parse_failed')
    }
    if (part.flags & ~0x080e || (part.method !== 0 && part.method !== 8)) {
      throw new XlsxFailure('unsupported_format')
    }
    declaredBytes += part.expandedBytes
    if (part.expandedBytes > XLSX_LIMITS.partBytes || declaredBytes > XLSX_LIMITS.expandedBytes) {
      throw new XlsxFailure('limit_exceeded')
    }
    if (part.method === 0 && part.compressedBytes !== part.expandedBytes) {
      throw new XlsxFailure('parse_failed')
    }
    parts.set(part.name, part)
    position = nextPosition
  }
  if (position !== centralEnd || parts.size === 0) {
    throw new XlsxFailure('parse_failed')
  }
  return { parts, offset }
}
