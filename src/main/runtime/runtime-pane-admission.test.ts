import { describe, expect, it, vi } from 'vitest'
import { GIT_KEY, leaf } from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { spawnInAdmittedPane } from './runtime-pane-admission'
import { fakeStore, gitSession, holderFor } from './runtime-workspace-layouts.test-fixture'

describe('spawnInAdmittedPane with a command start', () => {
  it("binds the spawn to the pane under the command's attempt, admitting nothing new", async () => {
    const live = new Set<string>()
    const { holder } = holderFor(fakeStore({ local: gitSession() }), live)
    const applied = holder.apply({
      type: 'startPane',
      workspace: GIT_KEY,
      paneKey: `tab-1:${leaf(1)}`
    })
    const paneStart = applied.ok ? applied.starts?.[0] : undefined
    const controller = { spawn: vi.fn(async () => ({ id: 'pty-new' })), kill: vi.fn(() => true) }

    await spawnInAdmittedPane(holder, controller, {
      cols: 80,
      rows: 24,
      worktreeId: GIT_KEY,
      tabId: 'tab-1',
      leafId: leaf(1),
      paneStart
    })
    live.add('pty-new')
    holder.republish('local', GIT_KEY)

    expect(controller.spawn).toHaveBeenCalledWith(expect.not.objectContaining({ paneStart }))
    expect(holder.published(GIT_KEY)?.tabs).toHaveLength(1)
    expect(holder.published(GIT_KEY)?.tabs[0]?.terminal?.panes).toEqual([
      { leafId: leaf(1), ptyId: 'pty-new', status: 'running', liveTitle: 'title of pty-new' }
    ])
  })
})
