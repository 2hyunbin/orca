import { describe, expect, it, vi } from 'vitest'
import {
  addWorkspace,
  emptySession,
  GIT_KEY,
  leaf
} from '../../shared/workspace-layout/workspace-layout-session.test-fixture'
import type { LayoutNavigateRequest } from '../../shared/workspace-layout/workspace-layout-stream-frames'
import { applyClientLayoutCommand, type LayoutCommandHost } from './runtime-layout-commands'
import { RuntimeLayoutViews } from './runtime-layout-views'
import { fakeStore, gitSession, holderFor } from './runtime-workspace-layouts.test-fixture'

function setup(session = gitSession(), live = new Set<string>(['pty-1'])) {
  const store = fakeStore({ local: session })
  const { holder, events, stopped } = holderFor(store, live)
  const views = new RuntimeLayoutViews(holder, () => store)
  const host = {
    holder,
    views,
    shellOverrideRefusal: vi.fn<LayoutCommandHost['shellOverrideRefusal']>(() => null),
    startPanes: vi.fn<LayoutCommandHost['startPanes']>(),
    closedByUser: vi.fn<LayoutCommandHost['closedByUser']>(),
    paneMoved: vi.fn<LayoutCommandHost['paneMoved']>()
  }
  const navigations: LayoutNavigateRequest[] = []
  views.onNavigate('desktop', (request) => navigations.push(request))
  return { store, holder, views, host, events, stopped, navigations }
}

const fromDesktop = { viewId: 'desktop' as const }

describe('applyClientLayoutCommand', () => {
  it('refuses a workspace outside the in-memory catalog and creates nothing', () => {
    const { host, holder } = setup()
    const reply = applyClientLayoutCommand(
      host,
      { type: 'createTerminalTab', workspace: 'repo-9::/unknown' },
      fromDesktop
    )
    expect(reply).toEqual({ ok: false, code: 'workspace_not_found' })
    expect(holder.published('repo-9::/unknown')).toBeUndefined()
    expect(host.startPanes).not.toHaveBeenCalled()
  })

  it('refuses a shell the host cannot apply before anything is admitted', () => {
    const { host, holder } = setup()
    host.shellOverrideRefusal.mockReturnValue(new Error('no such shell here'))
    const reply = applyClientLayoutCommand(
      host,
      { type: 'createTerminalTab', workspace: GIT_KEY, creation: { shellOverride: 'cmd.exe' } },
      fromDesktop
    )
    expect(reply).toEqual({
      ok: false,
      code: 'shell_override_refused',
      message: 'no such shell here'
    })
    expect(holder.published(GIT_KEY)?.tabs).toHaveLength(1)
  })

  it('starts a created pane after the reply and shows it in the sender view only on select', () => {
    const { host, navigations } = setup()
    const reply = applyClientLayoutCommand(
      host,
      { type: 'createTerminalTab', workspace: GIT_KEY },
      { ...fromDesktop, select: true, initialSize: { cols: 90, rows: 30 } }
    )
    if (!reply.ok) {
      throw new Error(reply.code)
    }
    const starts = host.startPanes.mock.calls[0]
    expect(starts?.[0]).toBe('local')
    expect(starts?.[2]).toEqual([{ paneKey: reply.paneKey, attempt: expect.any(String) }])
    expect(starts?.[3]).toMatchObject({ initialSize: { cols: 90, rows: 30 } })
    expect(navigations).toEqual([{ kind: 'focusPane', workspace: GIT_KEY, paneKey: reply.paneKey }])

    applyClientLayoutCommand(host, { type: 'createTerminalTab', workspace: GIT_KEY }, fromDesktop)
    expect(navigations).toHaveLength(1)
  })

  it('republishes the workspace for a refused or no-op command, so a gesture drawing clears', () => {
    const { host, events } = setup()
    const before = events.length
    const refused = applyClientLayoutCommand(
      host,
      { type: 'equalizePanes', workspace: GIT_KEY, tabId: 'missing' },
      fromDesktop
    )
    expect(refused).toEqual({ ok: false, code: 'tab_not_found' })
    expect(events.slice(before)).toEqual([expect.objectContaining({ key: GIT_KEY })])
  })

  it('keeps an editor tab whose view reported a draft unless forced, and forgets the draft on close', () => {
    const session = addWorkspace(emptySession(), GIT_KEY, [
      { id: 'group-a', tabs: [{ id: 'editor:a.ts', kind: 'editor' }] }
    ])
    const { host, views } = setup(session)
    views.setDraftState(GIT_KEY, 'editor:a.ts', true)
    const kept = applyClientLayoutCommand(
      host,
      { type: 'closeTabs', workspace: GIT_KEY, tabIds: ['editor:a.ts'] },
      fromDesktop
    )
    expect(kept).toMatchObject({
      ok: true,
      closed: [],
      refused: [{ tabId: 'editor:a.ts', code: 'editor_tab_has_unsaved_draft' }]
    })
    const forced = applyClientLayoutCommand(
      host,
      { type: 'closeTabs', workspace: GIT_KEY, tabIds: ['editor:a.ts'], force: true },
      fromDesktop
    )
    expect(forced).toMatchObject({ ok: true, closed: ['editor:a.ts'] })
    expect(views.draftTabIds(GIT_KEY)).toEqual([])
  })

  it('tells a launch in a closed pane or tab that the user closed it', () => {
    const session = addWorkspace(emptySession(), GIT_KEY, [
      {
        id: 'group-a',
        tabs: [
          {
            id: 'bar-1',
            entityId: 'tab-1',
            leaves: [
              [leaf(1), 'pty-1'],
              [leaf(2), 'pty-2']
            ]
          }
        ]
      }
    ])
    const { host, stopped } = setup(session, new Set(['pty-1', 'pty-2']))
    applyClientLayoutCommand(
      host,
      { type: 'closePane', workspace: GIT_KEY, tabId: 'bar-1', leafId: leaf(2) },
      fromDesktop
    )
    applyClientLayoutCommand(
      host,
      { type: 'closeTabs', workspace: GIT_KEY, tabIds: ['bar-1'] },
      fromDesktop
    )
    expect(host.closedByUser.mock.calls).toEqual([
      [GIT_KEY, { kind: 'pane', tabId: 'tab-1', leafId: leaf(2) }],
      [GIT_KEY, { kind: 'tab', tabId: 'tab-1' }]
    ])
    expect(stopped).toEqual(['pty-2', 'pty-1'])
  })

  it('moves agent status and pane-keyed records with a pane moved into a new tab', () => {
    const session = addWorkspace(emptySession(), GIT_KEY, [
      {
        id: 'group-a',
        tabs: [
          {
            id: 'tab-1',
            leaves: [
              [leaf(1), 'pty-1'],
              [leaf(2), 'pty-2']
            ]
          }
        ]
      }
    ])
    const { host, holder } = setup(session, new Set(['pty-1', 'pty-2']))
    const reply = applyClientLayoutCommand(
      host,
      { type: 'movePaneToNewTab', workspace: GIT_KEY, tabId: 'tab-1', leafId: leaf(2) },
      fromDesktop
    )
    if (!reply.ok || !reply.tabId) {
      throw new Error('not moved')
    }
    const moved = holder.published(GIT_KEY)?.tabs.find((tab) => tab.id === reply.tabId)
    expect(host.paneMoved).toHaveBeenCalledWith({
      worktreeId: GIT_KEY,
      sourceTabId: 'tab-1',
      targetTabId: moved?.entityId,
      leafId: leaf(2),
      ptyId: 'pty-2'
    })
  })
})
