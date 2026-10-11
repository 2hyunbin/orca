import { describe, expect, it } from 'vitest'
import type { WorkspaceLayoutModel } from '../../shared/workspace-layout/workspace-layout-model'
import { emptyLayoutBeside } from '../../shared/workspace-layout/workspace-layout-model-rules'
import {
  paneTerminalFact,
  projectRuntimeLeafRecords,
  runtimeLeafKey,
  type RuntimeLeafPtyFacts,
  type RuntimeLeafProjection,
  type RuntimeLeafProjectionInput
} from './runtime-leaf-record-projection'
import {
  LEAF_1,
  LEAF_2,
  LEAF_3,
  LIVENESS_VERDICTS,
  MIRROR_LEAVES_STEP_1,
  MIRROR_LEAVES_STEP_2,
  MIRROR_TABS,
  PTY_FACTS,
  TAB_1_ROOT,
  WORKTREE_ID
} from './runtime-leaf-record-projection.test-fixture'
import type { RuntimeLeafRecord } from './runtime-terminal-state-records'

/** The holder's model of the fixture's workspace: tab-bar ids differ from the terminal ids. */
function fixtureModel(leaf2PtyId: string): WorkspaceLayoutModel {
  const terminal = (id: string, entityId: string, defaultTitle: string) => ({
    id,
    entityId,
    createdAt: 1,
    customTitle: null,
    color: null,
    kind: 'terminal' as const,
    terminal: { defaultTitle }
  })
  return {
    hostId: 'local',
    workspaces: {
      [WORKTREE_ID]: {
        worktreeId: WORKTREE_ID,
        groups: [{ id: 'group-1', tabOrder: ['bar-1', 'bar-2'] }],
        tabs: [
          { ...terminal('bar-1', 'tab-1', 'Terminal 1'), panes: { root: TAB_1_ROOT } },
          {
            ...terminal('bar-2', 'tab-2', 'Terminal 2'),
            panes: { root: { type: 'leaf', leafId: LEAF_3 } }
          }
        ],
        leaves: { [LEAF_1]: { ptyId: 'pty-a' }, [LEAF_2]: { ptyId: leaf2PtyId } }
      }
    },
    records: {},
    legacy: { terminalRowOwners: {} }
  }
}

function projectFixture(
  leaf2PtyId: string,
  previous: RuntimeLeafProjection | null,
  ptys: Partial<Record<string, RuntimeLeafPtyFacts>> = PTY_FACTS
): RuntimeLeafProjection {
  const beside = emptyLayoutBeside()
  beside.desktopView.panes['tab-1'] = { activeLeafId: LEAF_2, expandedLeafId: null }
  beside.facts.terminalRows['tab-1'] = { title: 'build watch' }
  beside.facts.terminalRows['tab-2'] = { title: 'Terminal 2' }
  const input: RuntimeLeafProjectionInput = {
    partitions: [{ ...beside, layout: fixtureModel(leaf2PtyId) }],
    ptysById: new Map(Object.entries(ptys).flatMap(([id, facts]) => (facts ? [[id, facts]] : []))),
    livenessOf: (ptyId) => LIVENESS_VERDICTS[ptyId] ?? null,
    generatedTitlesEnabled: true,
    previous
  }
  return projectRuntimeLeafRecords(input)
}

/**
 * The mirror's records with the projection's two named differences: no renderer pane id, and a
 * pane title dated by its own OSC observation instead of the graph sync that relayed it.
 */
function asProjected(leaves: RuntimeLeafRecord[]): Map<string, RuntimeLeafRecord> {
  return new Map(
    leaves.map((leaf) => [
      runtimeLeafKey(leaf.tabId, leaf.leafId),
      { ...leaf, paneRuntimeId: -1, paneTitleUpdatedAt: leaf.lastOscTitleAt }
    ])
  )
}

describe('projectRuntimeLeafRecords', () => {
  it("matches today's mirror tabs and leaves for the captured graph", () => {
    const projection = projectFixture('pty-b', null)

    expect(projection.tabs).toEqual(new Map(MIRROR_TABS.map((tab) => [tab.tabId, tab])))
    expect(projection.leaves).toEqual(asProjected(MIRROR_LEAVES_STEP_1))
    expect([...projection.leavesByPtyId.keys()]).toEqual(['pty-a', 'pty-b'])
    expect(projection.leavesByPtyId.get('pty-b')?.map((leaf) => leaf.leafId)).toEqual([LEAF_2])
  })

  it('counts a pane rebinding in ptyGeneration across projections, as the mirror does', () => {
    const first = projectFixture('pty-b', null)
    const second = projectFixture('pty-c', first)

    expect(second.leaves).toEqual(asProjected(MIRROR_LEAVES_STEP_2))
    expect(
      projectFixture('pty-c', second).leaves.get(runtimeLeafKey('tab-1', LEAF_2))
    ).toMatchObject({ ptyGeneration: 1 })
  })

  it('projects every terminal tab the model holds, mounted or not', () => {
    const { tabs, leaves } = projectFixture('pty-b', null, {})

    expect([...tabs.keys()]).toEqual(['tab-1', 'tab-2'])
    expect(leaves.size).toBe(3)
  })

  it('leaves a saved binding the registry does not hold live unwritable', () => {
    const leaf = projectFixture('pty-b', null, {}).leaves.get(runtimeLeafKey('tab-1', LEAF_1))

    expect(leaf).toMatchObject({
      ptyId: 'pty-a',
      connected: false,
      writable: false,
      tailBuffer: []
    })
  })

  it('falls back to the first pane when the desktop focused a pane that is gone', () => {
    const beside = emptyLayoutBeside()
    beside.desktopView.panes['tab-1'] = { activeLeafId: 'gone', expandedLeafId: null }
    const projection = projectRuntimeLeafRecords({
      partitions: [{ ...beside, layout: fixtureModel('pty-b') }],
      ptysById: new Map(),
      livenessOf: () => null,
      generatedTitlesEnabled: false,
      previous: null
    })

    expect(projection.tabs.get('tab-1')?.activeLeafId).toBe(LEAF_1)
    expect(projection.tabs.get('tab-2')).toMatchObject({ title: 'Terminal 2' })
  })

  it('hands out records a reader cannot write through', () => {
    const leaf = projectFixture('pty-b', null).leaves.get(runtimeLeafKey('tab-1', LEAF_1))!

    // @ts-expect-error connection is the PTY record's fact, not the projection's.
    leaf.connected = false
    // @ts-expect-error the OSC title is the title tracker's PTY fact.
    leaf.lastOscTitle = 'x'
  })
})

describe('paneTerminalFact', () => {
  const registry = (facts: Partial<RuntimeLeafPtyFacts> | null, verdict = null) => ({
    ptysById: new Map(facts ? [['pty', { ...PTY_FACTS['pty-a'], ...facts }]] : []),
    livenessOf: () => verdict
  })

  it('reads the host verdict first, then the PTY record', () => {
    expect(paneTerminalFact(null, registry({}))).toBeNull()
    expect(paneTerminalFact('pty', registry(null))).toBeNull()
    expect(paneTerminalFact('pty', registry({}))).toBe('live')
    expect(paneTerminalFact('pty', registry({ connected: false, lastExitCode: 0 }))).toBe('exited')
    expect(
      paneTerminalFact('pty', {
        ...registry({}),
        livenessOf: () => ({ status: 'unverifiable', reason: 'host lost' })
      })
    ).toBe('unverifiable')
  })

  it('never reads a disconnect without an exit as an exit', () => {
    expect(paneTerminalFact('pty', registry({ connected: false, lastExitCode: null }))).toBe(
      'unverifiable'
    )
  })
})
