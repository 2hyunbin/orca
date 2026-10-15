import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { diffStoredSession } from '../../../shared/workspace-layout/workspace-layout-load-report'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import {
  closeTerminalSurfaceInWorkspaceSession,
  collectTerminalLayoutLeafIds
} from '../../runtime/terminal-surface-close'
import { applyCommandToSession } from './terminal-pane-admission'
import { leafIds, WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID,
  openTopologyStore
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const WORKTREE = FIXTURE_GIT_WORKTREE_ID
const TAB = 'tab-1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** Fields only the legacy close writes, which no reader distinguishes from their absence. */
const LEGACY_ONLY = new Set([
  // The legacy close re-derives the active tab's type; layout.apply leaves selection alone.
  'session/session/activeTabTypeByWorktree',
  // An empty map where none was stored.
  'session/session/terminalSurfaceTombstonesByPaneKey'
])

/**
 * Known gap, the same one the record-patch test pins: the load folds this legacy row into the
 * tab-bar tab whose terminal it repeats, so the stored row keeps its terminal id after the close.
 */
const FOLDED_LEGACY_ROW_CLOSES = new Map([
  [
    'tab-legacy',
    ['row/repo-1::/Users/dev/orca|tab-legacy/ptyId', 'layout/tab-legacy/ptyIdsByLeafId']
  ]
])

describe('layout.apply closePane against the legacy pane close', () => {
  const profiles = [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES]

  it.each(profiles.map((profile) => [profile.name, profile] as const))(
    '%s: writes what the legacy close writes, and refuses a tab’s last pane',
    (_name, profile) => {
      const stored = profile.build()
      for (const [worktreeId, tabs] of Object.entries(stored.tabsByWorktree)) {
        for (const tab of tabs) {
          const panes = collectTerminalLayoutLeafIds(stored.terminalLayoutsByTabId[tab.id]?.root)
          for (const leafId of panes) {
            const target = { kind: 'pane', tabId: tab.id, leafId } as const
            const legacy = closeTerminalSurfaceInWorkspaceSession(stored, worktreeId, target, {
              reason: 'user'
            })
            const dark = applyCommandToSession(profile.hostId, stored, {
              type: 'closePane',
              workspace: worktreeId,
              tabId: tab.id,
              leafId,
              userPaneClose: {}
            })
            const label = `${tab.id}:${leafId}`
            if (legacy.resolution !== 'pane') {
              // The legacy close changes nothing here; nor may layout.apply (a refusal or no-op).
              expect(dark.session, label).toBeNull()
              continue
            }
            expect(dark.value.ok, label).toBe(true)
            const differences = diffStoredSession(legacy.session, dark.session ?? stored)
              .map(({ table, record, field }) => `${table}/${record}/${field}`)
              .filter((change) => !LEGACY_ONLY.has(change))
            expect(differences, label).toEqual(FOLDED_LEGACY_ROW_CLOSES.get(tab.id) ?? [])
          }
        }
      }
    }
  )

  it('refuses a pane restarted since main read the close', () => {
    const window = new WindowSession(getDefaultWorkspaceSession())
    window.addTab(WORKTREE, TAB, LEAF_A)
    window.setLayout(
      TAB,
      {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_B }
      },
      { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' }
    )
    window.session.terminalPtyIncarnationsByPaneKey = { [`${TAB}:${LEAF_B}`]: 'incarnation-2' }
    const close = { type: 'closePane', workspace: WORKTREE, tabId: TAB, leafId: LEAF_B } as const

    expect(
      applyCommandToSession('local', window.snapshot(), {
        ...close,
        userPaneClose: { incarnationId: 'incarnation-1' }
      }).value
    ).toEqual({ ok: false, code: 'pane_restarted' })
    expect(
      applyCommandToSession('local', window.snapshot(), {
        ...close,
        userPaneClose: { incarnationId: 'incarnation-2' }
      }).value.ok
    ).toBe(true)
  })
})

describe('Store.applyLayoutCommand pane operations', () => {
  async function storeWithSplitTab(hostIds: string[]) {
    const directory = mkdtempSync(join(tmpdir(), 'orca-layout-pane-ops-'))
    directories.push(directory)
    const store = await openTopologyStore(directory, emptyTerminalSessionProfile())
    const window = new WindowSession(getDefaultWorkspaceSession())
    window.addTab(WORKTREE, TAB, LEAF_A)
    window.setLayout(
      TAB,
      {
        type: 'split',
        direction: 'vertical',
        ratio: 0.3,
        first: { type: 'leaf', leafId: LEAF_A },
        second: { type: 'leaf', leafId: LEAF_B }
      },
      { [LEAF_A]: 'pty-a', [LEAF_B]: 'pty-b' }
    )
    for (const hostId of hostIds) {
      store.setWorkspaceSession(window.snapshot(), hostId)
    }
    return store
  }

  it('closes the pane in every partition holding the tab', async () => {
    const store = await storeWithSplitTab(['local', 'ssh:target-1'])

    const reply = await store.applyLayoutCommand(
      { type: 'closePane', workspace: WORKTREE, tabId: TAB, leafId: LEAF_B, userPaneClose: {} },
      ['local', 'ssh:target-1']
    )

    expect(reply.ok).toBe(true)
    for (const hostId of ['local', 'ssh:target-1']) {
      expect(leafIds(store.getWorkspaceSession(hostId).terminalLayoutsByTabId[TAB]?.root)).toEqual([
        LEAF_A
      ])
    }
  })

  it('saves a pane title as the window saves it, and clears it on null', async () => {
    const store = await storeWithSplitTab(['local'])
    const rename = { type: 'renamePane', workspace: WORKTREE, tabId: TAB, leafId: LEAF_B } as const

    await store.applyLayoutCommand({ ...rename, title: 'Server' })
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.titlesByLeafId).toEqual({
      [LEAF_B]: 'Server'
    })

    await store.applyLayoutCommand({ ...rename, title: null })
    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.titlesByLeafId ?? {}).toEqual(
      {}
    )
  })

  it('equalizes as the window saves an even split: no ratio', async () => {
    const store = await storeWithSplitTab(['local'])

    await store.applyLayoutCommand({ type: 'equalizePanes', workspace: WORKTREE, tabId: TAB })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root).toEqual({
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    })
  })
})
