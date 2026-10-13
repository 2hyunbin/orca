import type { PluginViewerWorkerSdk } from '@orca/plugin-sdk/viewer'
import { XLSX_LIMITS, XlsxFailure } from './xlsx-limits'

export class XlsxByteSource {
  private bytes: Uint8Array = new Uint8Array(0)
  private offset = 0

  constructor(
    private readonly sdk: Pick<PluginViewerWorkerSdk, 'readBytes'>,
    readonly size: number
  ) {
    if (!Number.isSafeInteger(size) || size < 22 || size > XLSX_LIMITS.inputBytes) {
      throw new XlsxFailure(size > XLSX_LIMITS.inputBytes ? 'limit_exceeded' : 'unsupported_format')
    }
  }

  async read(position: number, length: number): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(position) ||
      !Number.isSafeInteger(length) ||
      position < 0 ||
      length < 0 ||
      length > XLSX_LIMITS.readBytes ||
      position + length > this.size
    ) {
      throw new XlsxFailure('parse_failed')
    }
    if (position < this.offset || position + length > this.offset + this.bytes.length) {
      this.offset = position
      this.bytes = await this.sdk.readBytes(
        position,
        Math.min(XLSX_LIMITS.readBytes, this.size - position)
      )
      if (this.bytes.length !== Math.min(XLSX_LIMITS.readBytes, this.size - position)) {
        throw new XlsxFailure('parse_failed')
      }
    }
    return this.bytes.subarray(position - this.offset, position - this.offset + length)
  }
}
