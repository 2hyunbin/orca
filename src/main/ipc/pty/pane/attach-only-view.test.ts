import { describe, expect, it, vi } from 'vitest'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import { attachOnlyViewOf, attachViewWithoutOwner } from './attach-only-view'
import { attemptStablePaneAttach } from './stable-pane-attach'
import type { StablePaneOwner } from './stable-owner'

const OWNER: StablePaneOwner = {
  tabId: 'tab-1',
  leafId: '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  ptyId: 'pty-1',
  hasPersistedBinding: true
}

function providerOf(spawn: ReturnType<typeof vi.fn>): IPtyProvider {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a view of a pane calls only provider.spawn.
  return { spawn } as unknown as IPtyProvider
}

describe("a window's attach-only view of a pane main starts", () => {
  it('attaches to a live owner', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: OWNER.ptyId, isReattach: true })
    const attempt = await attemptStablePaneAttach({
      runtime: undefined,
      provider: providerOf(spawn),
      spawnOptions: { cols: 80, rows: 24, command: 'claude --resume s' },
      owner: OWNER,
      resolveOwner: () => OWNER,
      attachOnlyView: true
    })
    expect(attempt).toMatchObject({ attached: { owner: OWNER } })
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: OWNER.ptyId, attachOnly: true, command: undefined })
    )
  })

  it("starts nothing and keeps the binding when the owner's terminal is gone", async () => {
    const spawn = vi.fn().mockRejectedValue(new SessionNotFoundError(OWNER.ptyId))
    const keepAbsentBinding = vi.fn()
    await expect(
      attemptStablePaneAttach({
        runtime: undefined,
        provider: providerOf(spawn),
        spawnOptions: { cols: 80, rows: 24 },
        owner: OWNER,
        resolveOwner: () => OWNER,
        keepAbsentBinding,
        attachOnlyView: true
      })
    ).rejects.toThrow(PANE_NOT_LIVE_ERROR)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(keepAbsentBinding).not.toHaveBeenCalled()
  })

  it('with no recorded owner, attaches only to the named terminal', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1', isReattach: true })
    await attachViewWithoutOwner(providerOf(spawn), {
      cols: 80,
      rows: 24,
      sessionId: 'pty-1',
      command: 'claude --resume s'
    })
    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      cols: 80,
      rows: 24,
      sessionId: 'pty-1',
      attachOnly: true
    })
  })

  it('with no recorded owner and no live terminal, starts nothing', async () => {
    const spawn = vi.fn().mockRejectedValue(new SessionNotFoundError('pty-1'))
    await expect(
      attachViewWithoutOwner(providerOf(spawn), { cols: 80, rows: 24, sessionId: 'pty-1' })
    ).rejects.toThrow(PANE_NOT_LIVE_ERROR)
    await expect(attachViewWithoutOwner(providerOf(spawn), { cols: 80, rows: 24 })).rejects.toThrow(
      PANE_NOT_LIVE_ERROR
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('attachOnlyViewOf', () => {
  it('takes the flag only in a layout-owner build', async () => {
    const { ORCA_LAYOUT_OWNER_IS_MAIN } = await import('../../../../shared/layout-owner-switch')
    expect(attachOnlyViewOf({ attachOnlyView: true })).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN ? true : undefined
    )
    expect(attachOnlyViewOf({ attachOnlyView: 'yes' })).toBeUndefined()
  })
})
