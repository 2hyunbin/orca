import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'

const mocks = vi.hoisted(() => {
  const sent: { reply: LayoutApplyReply } = { reply: { ok: true, result: {} } }
  return { sent }
})
vi.mock('@/lib/resolve-owner', () => ({ runtimeEnvironmentIdUnlessTwin: () => null }))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => mocks.sent.reply)
}))
vi.mock('@/runtime/layout-frame-position', () => ({
  afterLayoutFrame: (_seq: number | undefined, run: () => void) => run()
}))
vi.mock('@/runtime/layout-owner-pane-intents', () => ({ holdTabPaneTree: () => () => {} }))

import { sendLayoutApply } from './layout-apply-send'

const RENAME = { type: 'renamePane', tabId: 'tab-1', leafId: 'leaf-1', title: 'Pane' } as const

async function send(reply: LayoutApplyReply) {
  mocks.sent.reply = reply
  const handlers = { apply: vi.fn(), asToday: vi.fn(), refused: vi.fn(), unapplied: vi.fn() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the owner lookup is mocked and never reads the state.
  sendLayoutApply({} as never, 'wt-1', RENAME, handlers)
  await vi.waitFor(() => {
    const calls = Object.values(handlers).reduce(
      (sum, handler) => sum + handler.mock.calls.length,
      0
    )
    expect(calls).toBe(1)
  })
  return handlers
}

describe('sendLayoutApply', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}))

  it('refuses a change on a workspace a WSL move has paused, drawing nothing', async () => {
    const handlers = await send({ ok: false, code: 'wsl_move_in_progress' })

    expect(handlers.refused).toHaveBeenCalledWith('wsl_move_in_progress')
    expect(handlers.apply).not.toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalledWith(
      '[layout-owner] renamePane refused:',
      'wsl_move_in_progress'
    )
  })

  it('handles other refusals and successes as before', async () => {
    const refused = await send({ ok: false, code: 'last_pane' })
    expect(refused.refused).toHaveBeenCalledWith('last_pane')

    const applied = await send({ ok: true, result: { tabId: 'tab-1' } })
    expect(applied.apply).toHaveBeenCalledWith({ tabId: 'tab-1' })
  })
})
