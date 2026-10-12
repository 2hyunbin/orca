import { describe, expect, it, vi } from 'vitest'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { startPanes } from './runtime-pane-starts'
import {
  fakeStore,
  gitSession,
  holderFor,
  SSH_HOST,
  SSH_KEY
} from './runtime-workspace-layouts.test-fixture'

const paneKey = `tab-1:${leaf(1)}`

function startedPane(live = new Set<string>()) {
  const { holder } = holderFor(fakeStore({ local: gitSession() }), live)
  const applied = holder.apply({ type: 'startPane', workspace: GIT_KEY, paneKey })
  if (!applied.ok) {
    throw new Error(applied.code)
  }
  return { holder, starts: applied.starts ?? [] }
}

describe('startPanes', () => {
  it('leaves a pane whose terminal still runs alone', () => {
    expect(startedPane(new Set(['pty-1'])).starts).toEqual([])
  })

  it("restores a restorable pane's own terminal through the runtime create path, in the background", () => {
    const { holder, starts } = startedPane()
    expect(starts).toEqual([{ paneKey, attempt: expect.any(String), restoreSessionId: 'pty-1' }])
    const createTerminal = vi.fn(async () => ({}))
    startPanes({ holder, createTerminal }, 'local', GIT_KEY, starts, {
      initialSize: { cols: 80, rows: 24 }
    })
    expect(createTerminal).toHaveBeenCalledWith(`id:${GIT_KEY}`, {
      tabId: 'tab-1',
      leafId: leaf(1),
      paneStart: starts[0],
      presentation: 'background',
      sessionId: 'pty-1',
      initialSize: { cols: 80, rows: 24 }
    })
  })

  it('starts nothing on a saved ssh: partition, whose panes wait for their host', () => {
    const store = fakeStore({
      [SSH_HOST]: addWorkspace(
        emptySession(),
        SSH_KEY,
        [{ id: 'group-h', tabs: [{ id: 'tab-h', leaves: [[leaf(6)]] }] }],
        SSH_HOST
      )
    })
    const { holder } = holderFor(store)
    const applied = holder.apply({
      type: 'startPane',
      workspace: SSH_KEY,
      paneKey: `tab-h:${leaf(6)}`
    })
    const createTerminal = vi.fn(async () => ({}))
    startPanes(
      { holder, createTerminal },
      SSH_HOST,
      SSH_KEY,
      (applied.ok && applied.starts) || [],
      {}
    )
    expect(createTerminal).not.toHaveBeenCalled()
    expect(holder.published(SSH_KEY)?.tabs[0]?.terminal?.panes[0]?.status).toBe('waiting_for_host')
  })

  it('leaves a pane whose start failed as failed, and starts it fresh next time', async () => {
    const { holder, starts } = startedPane()
    const createTerminal = vi.fn(async () => {
      throw new Error('spawn refused')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    startPanes({ holder, createTerminal }, 'local', GIT_KEY, starts, {})
    await vi.waitFor(() =>
      expect(holder.published(GIT_KEY)?.tabs[0]?.terminal?.panes[0]?.status).toBe('failed')
    )
    const again = holder.apply({ type: 'startPane', workspace: GIT_KEY, paneKey })
    expect(again.ok && again.starts).toEqual([{ paneKey, attempt: expect.any(String) }])
  })
})
