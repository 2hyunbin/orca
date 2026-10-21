import { describe, expect, it, vi } from 'vitest'
import { SessionNotFoundError } from '../../../daemon/daemon-errors'
import type { IPtyProvider } from '../../../providers/pty-provider-contract'
import { PANE_NOT_LIVE_ERROR } from '../../../../shared/pane-attach-only-view'
import { spawnForStablePane, type StablePaneOwner } from './stable-owner'

const OWNER: StablePaneOwner = {
  tabId: 'tab-1',
  leafId: '1b3f2c4d-5e6a-4b7c-8d9e-0f1a2b3c4d5e',
  ptyId: 'pty-1',
  hasPersistedBinding: true
}

function viewOf(spawn: ReturnType<typeof vi.fn>, owner: StablePaneOwner | null) {
  const onFreshSpawn = vi.fn()
  const keepAbsentBinding = vi.fn()
  return {
    onFreshSpawn,
    keepAbsentBinding,
    run: () =>
      spawnForStablePane({
        runtime: undefined,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a view of a stable pane calls only provider.spawn.
        provider: { spawn } as unknown as IPtyProvider,
        spawnOptions: { cols: 80, rows: 24, sessionId: 'pty-1', command: 'claude --resume s' },
        owner,
        resolveOwner: () => owner,
        onFreshSpawn,
        keepAbsentBinding,
        attachOnlyView: true
      })
  }
}

describe("a window's attach-only view of a pane main starts", () => {
  it('attaches to a live owner', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: OWNER.ptyId, isReattach: true })
    const result = await viewOf(spawn, OWNER).run()
    expect(result.owner).toBe(OWNER)
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: OWNER.ptyId, attachOnly: true, command: undefined })
    )
  })

  it("starts nothing and keeps the binding when the owner's terminal is gone", async () => {
    const spawn = vi.fn().mockRejectedValue(new SessionNotFoundError(OWNER.ptyId))
    const view = viewOf(spawn, OWNER)
    await expect(view.run()).rejects.toThrow(PANE_NOT_LIVE_ERROR)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(view.keepAbsentBinding).not.toHaveBeenCalled()
    expect(view.onFreshSpawn).not.toHaveBeenCalled()
  })

  it('with no recorded owner, attaches only to the named terminal', async () => {
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-1', isReattach: true })
    const result = await viewOf(spawn, null).run()
    expect(result.owner).toBeNull()
    expect(spawn).toHaveBeenCalledExactlyOnceWith({
      cols: 80,
      rows: 24,
      sessionId: 'pty-1',
      attachOnly: true
    })
  })

  it('with no recorded owner and no live terminal, starts nothing', async () => {
    const spawn = vi.fn().mockRejectedValue(new SessionNotFoundError('pty-1'))
    const view = viewOf(spawn, null)
    await expect(view.run()).rejects.toThrow(PANE_NOT_LIVE_ERROR)
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(view.onFreshSpawn).not.toHaveBeenCalled()
  })
})

describe('attachOnlyViewOf', () => {
  it('takes the flag only in a layout-owner build', async () => {
    const { attachOnlyViewOf } = await import('./attach-only-view')
    const { ORCA_LAYOUT_OWNER_IS_MAIN } = await import('../../../../shared/layout-owner-switch')
    expect(attachOnlyViewOf({ attachOnlyView: true })).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN ? true : undefined
    )
    expect(attachOnlyViewOf({ attachOnlyView: 'yes' })).toBeUndefined()
  })
})
