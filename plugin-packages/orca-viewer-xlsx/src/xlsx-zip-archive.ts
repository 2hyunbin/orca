import { Inflate } from 'fflate'
import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'
import { XlsxByteSource } from './xlsx-byte-source'
import { updateXlsxCrc32 } from './xlsx-crc32'
import { XLSX_LIMITS, XlsxBudget, XlsxFailure } from './xlsx-limits'
import { readXlsxZipDirectory, xlsxZipName, type XlsxZipPart } from './xlsx-zip-directory'

export class XlsxZipArchive {
  private readonly ranges = new Map<string, { start: number; end: number }>()

  private constructor(
    private readonly source: XlsxByteSource,
    readonly parts: ReadonlyMap<string, XlsxZipPart>,
    private readonly centralOffset: number,
    readonly budget: XlsxBudget
  ) {}

  static async open(
    sdk: Pick<PluginViewerWorkerSdk, 'readBytes'>,
    size: number
  ): Promise<XlsxZipArchive> {
    const source = new XlsxByteSource(sdk, size)
    const budget = new XlsxBudget()
    const directory = await readXlsxZipDirectory(source, budget)
    return new XlsxZipArchive(source, directory.parts, directory.offset, budget)
  }

  async readPart(
    name: string,
    consume: (bytes: Uint8Array, final: boolean) => void
  ): Promise<void> {
    const part = this.parts.get(name)
    if (!part) {
      throw new XlsxFailure('parse_failed')
    }
    if (this.ranges.has(name)) {
      throw new XlsxFailure('parse_failed')
    }
    const header = await this.source.read(part.localOffset, 30)
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    const nameBytes = view.getUint16(26, true)
    const start = part.localOffset + 30 + nameBytes + view.getUint16(28, true)
    const end = start + part.compressedBytes
    if (
      view.getUint32(0, true) !== 0x04034b50 ||
      view.getUint16(6, true) !== part.flags ||
      view.getUint16(8, true) !== part.method ||
      nameBytes > 2048 ||
      end > this.centralOffset ||
      xlsxZipName(await this.source.read(part.localOffset + 30, nameBytes)) !== part.name
    ) {
      throw new XlsxFailure('parse_failed')
    }
    if (
      !(part.flags & 8) &&
      (view.getUint32(14, true) !== part.crc ||
        view.getUint32(18, true) !== part.compressedBytes ||
        view.getUint32(22, true) !== part.expandedBytes)
    ) {
      throw new XlsxFailure('parse_failed')
    }
    for (const range of this.ranges.values()) {
      if (part.localOffset < range.end && end > range.start) {
        throw new XlsxFailure('parse_failed')
      }
    }
    this.ranges.set(name, { start: part.localOffset, end })
    let crc = 0xffffffff
    let expanded = 0
    const receive = (bytes: Uint8Array, final: boolean): void => {
      this.budget.check()
      expanded += bytes.length
      this.budget.expandedBytes += bytes.length
      if (
        expanded > XLSX_LIMITS.partBytes ||
        this.budget.expandedBytes > XLSX_LIMITS.expandedBytes
      ) {
        throw new XlsxFailure('limit_exceeded')
      }
      if (expanded > part.expandedBytes) {
        throw new XlsxFailure('parse_failed')
      }
      crc = updateXlsxCrc32(crc, bytes)
      if (final && (expanded !== part.expandedBytes || (crc ^ 0xffffffff) >>> 0 !== part.crc)) {
        throw new XlsxFailure('parse_failed')
      }
      consume(bytes, final)
    }
    const inflater = part.method === 8 ? new Inflate(receive) : null
    for (let position = start; position < end; position += XLSX_LIMITS.inflateInputBytes) {
      await this.budget.checkpoint()
      const bytes = await this.source.read(
        position,
        Math.min(XLSX_LIMITS.inflateInputBytes, end - position)
      )
      const final = position + bytes.length === end
      if (inflater) {
        inflater.push(bytes, final)
      } else {
        receive(bytes, final)
      }
    }
    if (start === end) {
      if (inflater) {
        inflater.push(new Uint8Array(0), true)
      } else {
        receive(new Uint8Array(0), true)
      }
    }
  }
}
