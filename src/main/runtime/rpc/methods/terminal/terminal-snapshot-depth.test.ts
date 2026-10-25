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

  it.each([
    // 5000 rows = 2.5 MB is over 1.75 MiB; 2500 rows fits.
    [500, 2500],
    // 2500 rows = 2 MB is still over; 1000 rows fits.
    [800, 1000]
  ])(
    'steps a desktop snapshot of %i bytes/row down to %i rows under 1.75 MiB',
    async (bytesPerRow, rows) => {
      const runtime = bufferSource(bytesPerRow)
      await expect(
        serializeBudgetedMobileSnapshot(runtime, 'pty-1', undefined, DESKTOP_PAIRED_SNAPSHOT_DEPTH)
      ).resolves.toMatchObject({ scrollbackRows: rows, truncatedByByteBudget: true })
    }
  )

  it('never offers a phone the desktop 2500-row step', async () => {
    // 1000 rows = 1 MB is over the phone's 512 KB, so it steps down to 500, never up to 2500.
    const runtime = bufferSource(1000)
    await serializeBudgetedMobileSnapshot(runtime, 'pty-1')
    expect(
      runtime.serializeTerminalBuffer.mock.calls.map(([, opts]) => opts.scrollbackRows)
    ).toEqual([1000, 500])
  })
})
