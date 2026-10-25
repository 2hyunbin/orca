import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_PAIRED_SNAPSHOT_DEPTH,
  serializeBudgetedMobileSnapshot
} from './terminal-snapshot-publication'

function bufferSource(bytesPerRow: number) {
  return {
    serializeTerminalBuffer: vi.fn(async (_ptyId: string, opts: { scrollbackRows?: number }) => ({
      data: 'x'.repeat((opts.scrollbackRows ?? 0) * bytesPerRow),
      cols: 80,
      rows: 24
    }))
  }
}

describe('budgeted initial snapshot depth', () => {
  it('keeps phones at 1000 rows', async () => {
    const runtime = bufferSource(10)
    await expect(serializeBudgetedMobileSnapshot(runtime, 'pty-1')).resolves.toMatchObject({
      scrollbackRows: 1000,
      truncatedByByteBudget: false
    })
    expect(runtime.serializeTerminalBuffer).toHaveBeenCalledTimes(1)
  })

  it('gives paired desktop clients desktop depth', async () => {
    const runtime = bufferSource(10)
    await expect(
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', undefined, DESKTOP_PAIRED_SNAPSHOT_DEPTH)
    ).resolves.toMatchObject({ scrollbackRows: 5000, truncatedByByteBudget: false })
  })

  it('steps a desktop snapshot down past the requested-snapshot byte budget', async () => {
    // 5000 rows = 2.5 MB is over the 2 MB budget; 1000 rows fits.
    const runtime = bufferSource(500)
    await expect(
      serializeBudgetedMobileSnapshot(runtime, 'pty-1', undefined, DESKTOP_PAIRED_SNAPSHOT_DEPTH)
    ).resolves.toMatchObject({ scrollbackRows: 1000, truncatedByByteBudget: true })
  })
})
