import { describe, expect, it } from 'vitest'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { applyLayoutCommand } from './workspace-layout-commands'
import type { LayoutCommand } from './workspace-layout-command-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from './workspace-layout-legacy-profile.test-fixture'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { diffStoredSession, stableJson } from './workspace-layout-load-report'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import type { WorkspaceLayoutModel } from './workspace-layout-model'
import { WORKSPACE_LAYOUT_PROFILES } from './workspace-layout-profile.test-fixture'
import { patchStoredSession } from './workspace-layout-record-patch'
import { saveWorkspaceLayout } from './workspace-layout-save'

const CONTEXT = {
  mintId: () => 'minted-id',
  mintLeafId: () => '99999999-9999-4999-8999-999999999999',
  now: () => 1
}

/** Commands over every workspace and tab a profile holds, covering adds, drops, edits and moves. */
function commandsFor(model: WorkspaceLayoutModel): LayoutCommand[] {
  const commands: LayoutCommand[] = []
  for (const [workspace, layout] of Object.entries(model.workspaces)) {
    commands.push({ type: 'createTerminalTab', workspace })
    commands.push({ type: 'openEditorTab', workspace, fileId: '/new.md', contentType: 'editor' })
    const lastGroup = layout.groups.at(-1)
    for (const tab of layout.tabs) {
      commands.push({ type: 'closeTabs', workspace, tabIds: [tab.id], force: true })
      commands.push({
        type: 'renameTab',
        workspace,
        tabId: tab.id,
        kind: 'custom',
        title: 'Renamed'
      })
      if (lastGroup) {
        commands.push({
          type: 'moveTab',
          workspace,
          tabId: tab.id,
          toGroupId: lastGroup.id,
          index: 0
        })
      }
      if (tab.kind !== 'terminal') {
        continue
      }
      const [first, second] = collectLayoutLeafIdsInOrder(tab.panes.root)
      if (first) {
        commands.push({
          type: 'splitPane',
          workspace,
          tabId: tab.id,
          leafId: first,
          direction: 'vertical'
        })
      }
      if (second) {
        commands.push({ type: 'closePane', workspace, tabId: tab.id, leafId: second })
        commands.push({ type: 'equalizePanes', workspace, tabId: tab.id })
      }
    }
  }
  return commands
}

const changedFields = (changes: ReturnType<typeof diffStoredSession>) =>
  changes.map(({ table, record, field }) => `${table}/${record}/${field}`).sort()
// Session fields are separate records here: one session field must not carry another along.
const changedRecords = (changes: ReturnType<typeof diffStoredSession>) => [
  ...new Set(
    changes.map(({ table, record, field }) =>
      table === 'session' ? `session/${field}` : `${table}/${record}`
    )
  )
]

const LIST_TABLES: Record<string, { order: string; field: string }> = {
  row: { order: 'row', field: 'tabsByWorktree' },
  terminalEntry: { order: 'entry', field: 'unifiedTabs' },
  entry: { order: 'entry', field: 'unifiedTabs' },
  group: { order: 'group', field: 'tabGroups' },
  file: { order: 'file', field: 'openFilesByWorktree' },
  browser: { order: 'browser', field: 'browserTabsByWorktree' }
}

/** A record written into a list the stored partition lacks also changes that list's order and keys. */
function withListConsequences(records: string[]): string[] {
  const allowed = new Set(records)
  for (const record of records) {
    const table = record.slice(0, record.indexOf('/'))
    const list = LIST_TABLES[table]
    if (list) {
      const key = record.slice(table.length + 1, record.lastIndexOf('|'))
      allowed.add(`${list.order}/${key}|$order`)
      allowed.add(`session/${list.field}`)
    }
  }
  return [...allowed]
}

describe('patchStoredSession', () => {
  const profiles = [...WORKSPACE_LAYOUT_PROFILES, ...LEGACY_WORKSPACE_LAYOUT_PROFILES]

  it.each(profiles.map((profile) => [profile.name, profile] as const))(
    '%s: writes only the records each command touched',
    (_name, profile) => {
      const stored = profile.build()
      const loaded = loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
      const before = saveWorkspaceLayout(loaded)
      const normalizedAtLoad = diffStoredSession(stored, before).length > 0
      let applied = 0
      for (const command of commandsFor(loaded.layout)) {
        const result = applyLayoutCommand(loaded.layout, command, CONTEXT)
        if (!result.ok) {
          continue
        }
        applied++
        const after = saveWorkspaceLayout({ ...loaded, layout: result.model })
        const patched = patchStoredSession(stored, before, after)
        const label = `${command.type} ${JSON.stringify(command)}`
        if (!normalizedAtLoad) {
          // A partition the load leaves alone: the patch is the full save, field for field.
          expect(stableJson(patched), label).toBe(stableJson(after))
        }
        const written = changedRecords(diffStoredSession(stored, patched))
        const commanded = withListConsequences(changedRecords(diffStoredSession(before, after)))
        expect(
          written.filter((record) => !commanded.includes(record)),
          `${label} commanded=${commanded.join(',')}`
        ).toEqual([])
      }
      expect(applied > 0 || Object.keys(loaded.layout.workspaces).length === 0).toBe(true)
    }
  )

  it('keeps a legacy partition’s unrelated records as stored when a pane splits', () => {
    const profile = LEGACY_WORKSPACE_LAYOUT_PROFILES.find(
      (candidate) => candidate.name === 'session from before the tab bar, with an open file'
    )!
    const stored = profile.build()
    const loaded = loadWorkspaceLayout(profile.hostId, stored, nameBasedLoadContext())
    const [workspace, tabs] = Object.entries(stored.tabsByWorktree)[0]!
    const tabId = tabs[0]!.id
    const leafId = collectLayoutLeafIdsInOrder(stored.terminalLayoutsByTabId[tabId]?.root)[0]!
    const result = applyLayoutCommand(
      loaded.layout,
      { type: 'splitPane', workspace, tabId, leafId, direction: 'vertical' },
      CONTEXT
    )
    if (!result.ok) {
      throw new Error(result.code)
    }

    const full = saveWorkspaceLayout({ ...loaded, layout: result.model })
    const patched = patchStoredSession(stored, saveWorkspaceLayout(loaded), full)

    expect(changedFields(diffStoredSession(stored, full)).length).toBeGreaterThan(2)
    expect(changedFields(diffStoredSession(stored, patched))).toEqual([
      `layout/${tabId}/root`,
      'session/session/terminalTopologyRevisionByRepoId'
    ])
    // Stored fields keep their order; the command's new field follows them.
    expect(Object.keys(patched).slice(0, Object.keys(stored).length)).toEqual(Object.keys(stored))
  })
})
