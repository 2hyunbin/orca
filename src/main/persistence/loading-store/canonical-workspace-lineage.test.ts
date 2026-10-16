import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'
import type { LineageEdge } from '../../../shared/worktree/lineage-types'
import {
  edgeToWorkspaceLineage,
  edgeToWorktreeLineage
} from '../../../shared/worktree/lineage-edge'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
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
function edge(instanceId: string, parent: string, createdAt = 1): LineageEdge {
  return {
    child: { instanceId, locator: worktreeWorkspaceKey(id) },
    parent: { instanceId: parent, locator: worktreeWorkspaceKey(`other::/${parent}`) },
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt
  }
}

it('keeps same-id owners independent through writes, real reload, rename and removal', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-canonical-lineage-'))
  const dataFile = join(directory, 'orca-data.json')
  const state = getDefaultPersistedState(directory)
  state.repos = [
    makeRepo({ id: 'repo', path: '/workspace', executionHostId: 'local' }),
    makeRepo({
      id: 'repo',
      path: '/workspace',
      connectionId: 'remote',
      executionHostId: 'ssh:remote'
    })
  ]
  writeFileSync(dataFile, JSON.stringify(state))
  let store = createSqliteTestStore(Store, { dataFile })
  store.setWorktreeMetaForHost(id, 'local', { instanceId: 'local-child' })
  store.setWorktreeMetaForHost(id, 'ssh:remote', { instanceId: 'remote-child' })
  for (const candidate of [
    edge('local-child', 'local-parent'),
    edge('remote-child', 'remote-parent')
  ]) {
    const lineage = edgeToWorktreeLineage(candidate)
    if (!lineage) {
      throw new Error('missing lineage')
    }
    store.setWorktreeLineage(id, lineage)
  }
  store.setWorkspaceLineage(edgeToWorkspaceLineage(edge('remote-child', 'changed-parent')))
  store.flushOrThrow()
  await closeTestStores()
  store = createSqliteTestStore(Store, { dataFile })
  expect(
    store
      .getLineageEdges()
      .map((row) => [row.child.instanceId, row.parent.instanceId])
      .sort()
  ).toEqual([
    ['local-child', 'local-parent'],
    ['remote-child', 'changed-parent']
  ])
  expect(store.getAllWorktreeLineage()[id]?.worktreeInstanceId).toBe(
    store.getWorktreeMeta(id)?.instanceId
  )
  const renamed = 'repo::/workspace/renamed'
  store.migrateWorktreeIdentity(id, renamed, 'ssh:remote')
  expect(
    store.getLineageEdges().find((row) => row.child.instanceId === 'remote-child')?.child.locator
  ).toBe(worktreeWorkspaceKey(renamed))
  expect(
    store.getLineageEdges().find((row) => row.child.instanceId === 'local-child')?.child.locator
  ).toBe(worktreeWorkspaceKey(id))
  store.removeWorktreeMeta(renamed, 'ssh:remote')
  store.setWorktreeMetaForHost(renamed, 'ssh:remote', { instanceId: 'new-occupant' })
  store.flushOrThrow()
  await closeTestStores()
  store = createSqliteTestStore(Store, { dataFile })
  expect(store.getLineageEdges().map((row) => row.child.instanceId)).toEqual(['local-child'])
  expect(store.getWorktreeLineage(renamed, 'new-occupant')).toBeUndefined()
  store.removeWorktreeMeta(id, 'local')
  expect(store.getLineageEdges()).toEqual([])
})

it('migrates raw child identities once, preserving conflicts and inert source rows', () => {
  const state = getDefaultPersistedState(tmpdir())
  delete state.lineageByChildInstance
  state.repos = [makeRepo({ id: 'repo', path: '/workspace' })]
  state.worktreeMeta[id] = mergeWorktreeMetaForWrite(undefined, {
    instanceId: 'child',
    hostId: 'local'
  })
  const worktree = edgeToWorktreeLineage(edge('child', 'worktree-parent', 2))
  if (!worktree) {
    throw new Error('missing lineage')
  }
  state.worktreeLineageById['wrong-map-key'] = worktree
  state.workspaceLineageByChildKey[worktreeWorkspaceKey('wrong-key')] = edgeToWorkspaceLineage(
    edge('child', 'workspace-parent', 2)
  )
  state.workspaceLineageByChildKey[worktreeWorkspaceKey('inert')] = {
    ...edgeToWorkspaceLineage(edge('missing-owner', 'parent')),
    childInstanceId: undefined
  }
  const orphan = edgeToWorktreeLineage(edge('unowned-instance', 'parent'))
  if (orphan) {
    state.worktreeLineageById.orphan = orphan
  }
  expect(initializeCanonicalLineage(state)).toBe(true)
  expect(state).toMatchObject({
    lineageByChildInstance: { child: { parent: { instanceId: 'workspace-parent' } } }
  })
  expect(state.lineageByChildInstance?.['unowned-instance']).toBeDefined()
  expect(Object.keys(state.legacyLineageRemainder ?? {})).toHaveLength(3)
  expect(Object.keys(state.worktreeLineageById)).toEqual([id])
  state.lineageByChildInstance = {}
  state.worktreeLineageById[id] = worktree
  expect(initializeCanonicalLineage(state)).toBe(false)
  expect(state.lineageByChildInstance).toEqual({})
  expect(state.worktreeLineageById).toEqual({})
})

it('validates saved ancestors across owners without adopting metadata or consulting caches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-lineage-ancestors-'))
  const dataFile = join(directory, 'orca-data.json')
  const state = getDefaultPersistedState(directory)
  const hosts = ['local', 'ssh:remote', 'ssh:third'] as const
  state.repos = hosts.map((host) =>
    makeRepo({ id: 'repo', path: '/workspace', executionHostId: host })
  )
  writeFileSync(dataFile, JSON.stringify(state))
  const store = createSqliteTestStore(Store, { dataFile })
  const rows = hosts.map((host, index) => {
    const instance = String(index)
    const locator = `repo::/workspace/${instance}`
    const meta = store.setWorktreeMetaForHost(locator, host, { instanceId: instance })
    const git = {
      path: `/workspace/${instance}`,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: false
    }
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
    store.setWorktreeLineage(rows[child].id, {
      worktreeId: rows[child].id,
      worktreeInstanceId: String(child),
      parentWorktreeId: rows[parent].id,
      parentWorktreeInstanceId: String(parent),
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: child
    })
  connect(0, 1)
  connect(1, 2)
  const migratingRead = vi.spyOn(store, 'getWorktreeMetaForHost')
  expect(() => controller.validateParent(rows[2], rows[0])).toThrow('lineage cycle')
  connect(1, 0)
  expect(() => controller.validateParent(rows[2], rows[0])).not.toThrow()
  expect(migratingRead).not.toHaveBeenCalled()
})
