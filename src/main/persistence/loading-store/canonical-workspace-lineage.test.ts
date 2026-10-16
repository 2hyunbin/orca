import {
  FOLDER_WORKSPACE,
  PROJECT_GROUP,
  manifest
} from '../../persistence-orcad-migration-catalog-fixture'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getDefaultPersistedState } from '../../../shared/constants'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'
import type { LineageEdge } from '../../../shared/worktree/lineage-types'
import {
  edgeToWorkspaceLineage,
  edgeToWorktreeLineage
} from '../../../shared/worktree/lineage-edge'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { pruneWorktreeStateForRepo } from '../tracking-repos/repo-worktree-pruning'
import { collectOrcadMigrationSourceDormantState } from '../migrating-orcad-catalog/orcad-source-dormant-state'
import { subtractOrcadMigrationSourceDormantState } from '../migrating-orcad-catalog/orcad-source-dormant-subtraction'
import { initializeCanonicalLineage } from './canonical-workspace-lineage'
import { closeTestStores, createSqliteTestStore, makeRepo } from '../../persistence-test-harness'
import { Store } from './store'
import { RuntimeWorktreeLineageController } from '../../runtime/runtime-worktree-lineage-controller'
import { mergeWorktree } from '../../ipc/worktree-metadata-merge'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getName: () => 'orca-test', getVersion: () => '0.0.0' }
}))
afterEach(closeTestStores)
const id = 'repo::/workspace/child'
const meta = (instanceId: string, hostId: ExecutionHostId = 'local') =>
  mergeWorktreeMetaForWrite(undefined, { instanceId, hostId })
function edge(instanceId: string, parent: string, createdAt = 1): LineageEdge {
  return {
    child: { instanceId, locator: worktreeWorkspaceKey(id) },
    parent: { instanceId: parent, locator: worktreeWorkspaceKey(`other::/${parent}`) },
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt
  }
}
function savedStore(state = getDefaultPersistedState(tmpdir())) {
  const dataFile = join(mkdtempSync(join(tmpdir(), 'lineage-')), 'orca-data.json')
  writeFileSync(dataFile, JSON.stringify(state))
  return { store: createSqliteTestStore(Store, { dataFile }), dataFile }
}
const hosts = ['local', 'ssh:remote', 'ssh:third'] as const
function registeredState() {
  const state = getDefaultPersistedState(tmpdir())
  state.repos = hosts.map((executionHostId) => makeRepo({ id: 'repo', executionHostId }))
  return state
}

it('persists a captured clear without attaching the next occupant or clearing its same-id sibling', async () => {
  const { store, dataFile } = savedStore(registeredState())
  for (const host of ['local', 'ssh:remote'] as const) {
    store.setWorktreeMetaForHost(id, host, { instanceId: host })
    store.setWorkspaceLineage(edgeToWorkspaceLineage(edge(host, 'parent')))
  }
  store.removeWorktreeLineage(id, 'ssh:remote')
  store.flushOrThrow()
  await closeTestStores()
  const restarted = createSqliteTestStore(Store, { dataFile })
  expect(restarted.getLineageEdges().map((row) => row.child.instanceId)).toEqual(['local'])
  restarted.removeWorktreeMeta(id, 'ssh:remote')
  restarted.setWorktreeMetaForHost(id, 'ssh:remote', { instanceId: 'replacement' })
  restarted.flushOrThrow()
  await closeTestStores()
  expect(
    createSqliteTestStore(Store, { dataFile })
      .getLineageEdges()
      .map((row) => row.child.instanceId)
  ).toEqual(['local'])
})

it.each([false, true])(
  'freezes only a uniquely owned legacy folder child once (ambiguous: %s)',
  async (ambiguous) => {
    const state = registeredState()
    delete state.lineageByChildInstance
    state.folderWorkspaces = [FOLDER_WORKSPACE]
    state.projectGroups = [PROJECT_GROUP]
    state.worktreeMeta[id] = meta('child', 'local')
    if (ambiguous) {
      state.worktreeIdentityAliases = { [`ssh:remote|${id}`]: ['remote'] }
      state.worktreeMetaByIdentity = {
        remote: meta('remote', 'ssh:remote')
      }
    }
    const legacy = {
      ...edgeToWorkspaceLineage(edge('child', 'parent')),
      childInstanceId: null,
      parentWorkspaceKey: `folder:${FOLDER_WORKSPACE.id}` as const,
      parentInstanceId: null
    }
    state.workspaceLineageByChildKey['worktree:wrong-map-key'] = legacy
    const { store, dataFile } = savedStore(state)
    expect(store.getLineageEdges()).toHaveLength(ambiguous ? 0 : 1)
    expect(store.getWorkspaceLineage(worktreeWorkspaceKey(id))?.childInstanceId).toBe(
      ambiguous ? undefined : 'child'
    )
    store.removeWorkspaceLineage(worktreeWorkspaceKey(id), 'child')
    store.setWorktreeMetaForHost(id, 'local', { instanceId: 'replacement' })
    store.flushOrThrow()
    await closeTestStores()
    expect(createSqliteTestStore(Store, { dataFile }).getLineageEdges()).toEqual([])
  }
)

it('prefers explicit instances, preserves conflicts, and ignores key order in agreeing duplicates', () => {
  const state = registeredState()
  delete state.lineageByChildInstance
  state.worktreeMeta[id] = meta('child', 'local')
  const explicit = edge('child', 'parent')
  const lineage = edgeToWorktreeLineage(explicit)
  if (!lineage) {
    throw new Error('missing lineage')
  }
  state.worktreeLineageById.wrong = lineage
  state.workspaceLineageByChildKey['worktree:wrong'] = edgeToWorkspaceLineage({
    ...explicit,
    parent: { locator: explicit.parent.locator, instanceId: 'parent' },
    createdAt: 2
  })
  initializeCanonicalLineage(state)
  expect(state.legacyLineageRemainder).toEqual({})
  expect(state.lineageByChildInstance).toEqual({
    child: expect.objectContaining({ createdAt: 2, capture: explicit.capture })
  })
  delete state.lineageByChildInstance
  state.workspaceLineageByChildKey = {
    [worktreeWorkspaceKey(id)]: {
      ...edgeToWorkspaceLineage(explicit),
      childInstanceId: null,
      parentWorkspaceKey: `folder:${FOLDER_WORKSPACE.id}` as const,
      parentInstanceId: null,
      createdAt: 99
    }
  }
  state.folderWorkspaces = [FOLDER_WORKSPACE]
  state.worktreeLineageById.wrong = lineage
  initializeCanonicalLineage(state)
  expect(state.lineageByChildInstance).toMatchObject({ child: explicit })
  expect(Object.keys(state.legacyLineageRemainder ?? {})).toHaveLength(2)
  state.lineageByChildInstance = {}
  state.worktreeLineageById.wrong = lineage
  initializeCanonicalLineage(state)
  expect(state.lineageByChildInstance).toEqual({})
})

it('validates saved ancestors per owner and snapshots existing children once per response', async () => {
  const { store } = savedStore(registeredState())
  const rows = hosts.map((host, index) => {
    const instanceId = String(index)
    const git = {
      path: `/workspace/${index}`,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: false
    }
    const meta = store.setWorktreeMetaForHost(`repo::${git.path}`, host, { instanceId })
    return {
      ...mergeWorktree('repo', git, meta),
      git,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null
    }
  })
  const controller = new RuntimeWorktreeLineageController({
    getStore: () => store,
    getCachedWorktrees: () => {
      throw new Error('cache read')
    },
    getDb: () => null,
    resolveWorktree: async () => rows[0],
    listResolvedWorktrees: async () => rows,
    showTerminal: async () => ({ worktreeId: rows[0].id })
  })
  const connect = (child: number, parent: number) =>
    store.setWorkspaceLineage(edgeToWorkspaceLineage(edge(String(child), String(parent))))
  connect(0, 1)
  connect(1, 2)
  expect(() => controller.validateParent(rows[2], rows[0])).toThrow('lineage cycle')
  connect(1, 0)
  expect(() => controller.validateParent(rows[2], rows[0])).not.toThrow()
})

it.each([false, true])('exports and subtracts both endpoints only (canonical: %s)', (canonical) => {
  const state = registeredState()
  const repo = makeRepo({ id: 'repo', executionHostId: 'ssh:remote' })
  const parentId = 'repo::/parent-renamed'
  state.worktreeMeta[id] = meta('child', 'ssh:remote')
  state.worktreeMeta[parentId] = meta('parent', 'ssh:remote')
  const relationship = edge('child', 'parent')
  state.worktreeLineageById[id] = edgeToWorktreeLineage(relationship)!
  state.workspaceLineageByChildKey[worktreeWorkspaceKey(id)] = edgeToWorkspaceLineage(relationship)
  if (canonical) {
    state.lineageByChildInstance = { child: relationship }
  } else {
    delete state.lineageByChildInstance
  }
  const source = { sshTargetId: 'remote', sshTargetGeneration: 1, targetLabel: 'Remote' }
  const catalog = { repositories: [repo], folderWorkspaces: [], projectGroups: [] }
  const collect = () => collectOrcadMigrationSourceDormantState(state, source, catalog).payload
  expect(collect().edges?.[0].parent.locator).toBe(worktreeWorkspaceKey(parentId))
  const complete = structuredClone(state)
  const moved = collect()
  subtractOrcadMigrationSourceDormantState(
    complete,
    manifest({ source, payload: { ...catalog, dormantState: moved } })
  )
  expect(complete.lineageByChildInstance).toEqual({})
  state.worktreeMeta[parentId].hostId = 'local'
  const excluded = collect()
  expect(excluded).toMatchObject({ edges: [], worktreeLineage: [], workspaceLineage: [] })
  subtractOrcadMigrationSourceDormantState(
    state,
    manifest({ source, payload: { ...catalog, dormantState: excluded } })
  )
  expect(state.lineageByChildInstance?.child).toMatchObject(relationship)
})

it('prunes only the derived owner even when saved hints name another host', () => {
  const state = registeredState()
  state.worktreeMeta[id] = meta('child', 'local')
  state.worktreeIdentityAliases = { [`ssh:remote|${id}`]: ['remote'] }
  state.worktreeMetaByIdentity = {
    remote: meta('remote', 'ssh:remote')
  }
  state.lineageByChildInstance = {
    child: edge('child', 'parent'),
    remote: {
      ...edge('remote', 'parent'),
      child: { instanceId: 'remote', locator: worktreeWorkspaceKey(id), hostId: 'local' }
    }
  }
  pruneWorktreeStateForRepo(state, 'repo', 'local', () => {})
  expect(Object.keys(state.lineageByChildInstance)).toEqual(['remote'])
})
