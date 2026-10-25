import { describe, expect, it, vi } from 'vitest'
import { desktopDepthModelSeed } from './desktop-depth-model-snapshot'

const PHONE = { data: 'last 1000 rows', cols: 80, rows: 24, seq: 7 }

function source(desktop: { data: string; seq?: number } | null, outputSequences = [7, 7]) {
  const sequences = [...outputSequences]
  return {
    getPtyOutputSequence: vi.fn(() => sequences.shift() ?? 7),
    serializeRendererTerminalBuffer: vi.fn(async () =>
      desktop ? { ...desktop, cols: 80, rows: 24 } : null
    )
  }
}

describe('desktopDepthModelSeed', () => {
  it('seeds main from a desktop-depth read of the same renderer sequence', async () => {
    const runtime = source({ data: 'all 1500 rows', seq: 7 })
    await expect(desktopDepthModelSeed(runtime, 'pty-1', PHONE)).resolves.toMatchObject({
      data: 'all 1500 rows'
    })
    expect(runtime.serializeRendererTerminalBuffer).toHaveBeenCalledWith('pty-1', {
      scrollbackRows: 5000
    })
  })

  it.each([
    ['the renderer moved past the phone snapshot', source({ data: 'newer', seq: 8 })],
    ['output arrived during the read', source({ data: 'raced', seq: 7 }, [7, 8])],
    ['the renderer has nothing to serialize', source(null)]
  ])('keeps the phone snapshot when %s', async (_case, runtime) => {
    await expect(desktopDepthModelSeed(runtime, 'pty-1', PHONE)).resolves.toBe(PHONE)
  })

  it('does not reread a snapshot without a sequence to match', async () => {
    const runtime = source({ data: 'all', seq: 7 })
    const seqless = { data: 'screen', cols: 80, rows: 24 }
    await expect(desktopDepthModelSeed(runtime, 'pty-1', seqless)).resolves.toBe(seqless)
    expect(runtime.serializeRendererTerminalBuffer).not.toHaveBeenCalled()
  })
})
