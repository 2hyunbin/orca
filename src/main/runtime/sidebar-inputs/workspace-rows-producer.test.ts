import { RuntimeWorktreeLineageController } from '../runtime-worktree-lineage-controller'
import { updateRuntimeManagedWorktreeMetadata } from '../runtime-managed-worktree-metadata'
import { buildRuntimeWorktreePsSummaries } from '../runtime-worktree-ps-summaries'
import { isWorkspaceHiddenBySidebarFilters } from '../workspace-notification-mute'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createStore,
  closeTestStores,
  testState,
  makeRepo,
  makeWorktreeLineage
} from '../../persistence-test-harness'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { projectCurrentStoreWorktreeLineage } from '../../worktree-lineage-candidates'
import { buildDetectedGitWorktrees } from '../../ipc/worktrees/listing/ssh-worktree-fallback'
import { readFeedWorkspaceRow } from '../../../shared/sidebar-list/sidebar-feed-worktrees'
import {
  getWorkspaceLineageRows,
  getWorktreeLineageProjection
} from '../../../shared/sidebar-list/worktree-lineage-projection'
import { WorkspaceRowsProducer } from './workspace-rows-producer'
// Runs on plain Node, as orcad does: rows come from the runtime's own listing and store.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeClientEvent } from '../../../shared/runtime-client-events'
import { OrcaRuntimeService } from '../orca-runtime'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { RuntimeStore } from '../runtime-store-contract'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { requireSwitchedOn } from './require-switched-on'
import { TestPhone } from './sidebar-inputs-feed.test-fixture'

vi.mock('../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

const localRepo: Repo = {
  id: 'repo-1',
  path: '/r',
  displayName: 'r',
  badgeColor: 'blue',
  addedAt: 1
}
const sshRepo: Repo = {
  id: 'repo-2',
  path: '/remote',
  displayName: 'remote',
  badgeColor: 'red',
  addedAt: 1,
  connectionId: 'box'
}

function resolved(
  id: string,
  repo: Repo,
  hostId: NonNullable<ResolvedWorktree['hostId']>
): ResolvedWorktree & { hostId: NonNullable<ResolvedWorktree['hostId']> } {
  return {
    id,
    repoId: repo.id,
    hostId,
    path: id.split('::')[1],
    branch: hostId === 'local' ? 'refs/heads/a' : '',
    head: '',
    isBare: false,
    isMainWorktree: false,
    displayName: 'a',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git: { path: id, head: '', branch: '', isBare: false, isMainWorktree: false }
  }
}

function setup(repos: Repo[] = [localRepo, sshRepo]) {
  let settings: Partial<ReturnType<RuntimeStore['getSettings']>> = {}
  const writeListeners = new Set<(domains: readonly string[] | undefined) => void>()
  const onWrite = (domains: readonly string[] | undefined): void =>
    writeListeners.forEach((listener) => listener(domains))
  const store: Pick<
    RuntimeStore,
    | 'getRepos'
    | 'getRepo'
    | 'getWorktreeMeta'
    | 'getAllWorktreeMeta'
    | 'getFolderWorkspaces'
    | 'getProjectGroups'
    | 'getSshTargets'
    | 'getAllWorktreeLineage'
    | 'getSettings'
    | 'onStateWritten'
  > = {
    getRepos: () => repos,
    getRepo: (id) => repos.find((repo) => repo.id === id),
    getWorktreeMeta: () => undefined,
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [],
    getProjectGroups: () => [],
    getSshTargets: () => [],
    getAllWorktreeLineage: () => ({}),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the visibility filter reads only absent fields as defaults.
    getSettings: () => settings as ReturnType<RuntimeStore['getSettings']>,
    onStateWritten: (listener) => {
      writeListeners.add(listener)
      return () => writeListeners.delete(listener)
    }
  }
  const listing: ResolvedWorktreeSnapshot = {
    // An SSH repo lists its stored rows whether or not the host answers.
    worktrees: [
      resolved('repo-1::/r/a', localRepo, 'local'),
      resolved('repo-2::/remote/b', sshRepo, 'ssh:box')
    ],
    platformByRepoId: new Map([['repo-1', 'linux']])
  }
  // The real listing cache and visibility filter run; only the scan and merge are stubbed.
  class Probe extends OrcaRuntimeService {
    protected override async computeResolvedWorktrees(): Promise<ResolvedWorktreeSnapshot> {
      return { ...listing, worktrees: [...listing.worktrees] }
    }

    emit(event: RuntimeClientEvent): void {
      this.emitClientEvent(event)
    }

    cachedListing(): Promise<ResolvedWorktreeSnapshot> {
      return this.listResolvedWorktreeSnapshot()
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rows read only the fields picked above.
  const runtime = new Probe(store as RuntimeStore)
  return {
    runtime,
    rows: requireSwitchedOn(runtime.workspaceRows),
    listing,
    write: (domains?: readonly string[]) => onWrite(domains),
    // As the store does: replace the settings in memory, then report a settings-tagged write.
    writeSettings: (updates: Partial<ReturnType<RuntimeStore['getSettings']>>) => {
      settings = { ...settings, ...updates }
      onWrite(['settings'])
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('WorkspaceRowsProducer', () => {
  it('lists local and stored SSH rows by host, with the terminal platform', async () => {
    const { rows } = setup()
    const { rows: snapshot } = await rows.snapshot()
    expect(Object.keys(snapshot)).toEqual(['local|repo-1::/r/a', 'ssh:box|repo-2::/remote/b'])
    expect(snapshot['local|repo-1::/r/a']).toMatchObject({ kind: 'git', terminalPlatform: 'linux' })
    expect(snapshot['ssh:box|repo-2::/remote/b']).toMatchObject({ hostId: 'ssh:box', branch: '' })
  })

  it('moves on catalog changes and metadata writes, never on session or unrelated settings writes', () => {
    const { runtime, rows, write } = setup()
    const at = (): number => rows.revision.value
    const start = at()
    write(['workspaceSession'])
    write(['settings'])
    runtime.emit({ type: 'workspaceViewChanged' })
    expect(at()).toBe(start)

    write(['worktreeMeta'])
    write(undefined)
    runtime.emit({ type: 'worktreesChanged', repoId: 'repo-1' })
    runtime.emit({ type: 'reposChanged' })
    expect(at()).toBe(start + 4)
  })

  it('moves when a settings write changes what the visibility filter reads, and only then', () => {
    const { rows, writeSettings } = setup()
    const at = (): number => rows.revision.value
    const start = at()
    writeSettings({ compactWorktreeCards: true })
    expect(at()).toBe(start)
    writeSettings({ worktreeVisibilityDefaults: { external: 'show' } })
    expect(at()).toBe(start + 1)
    writeSettings({ worktreeVisibilityDefaults: { external: 'show' } })
    expect(at()).toBe(start + 1)
    writeSettings({ workspaceDir: '/w' })
    writeSettings({ nestWorkspaces: false })
    writeSettings({ workspaceDirHistory: [{ path: '/old', nestWorkspaces: true }] })
    expect(at()).toBe(start + 4)
  })

  it('republishes rows to the feed when a visibility setting is saved', async () => {
    // Added after the rollout, so the global default decides whether an external checkout shows.
    const recentRepo: Repo = { ...localRepo, id: 'repo-3', externalWorktreeVisibilityLegacy: false }
    const { runtime, listing, writeSettings } = setup([localRepo, sshRepo, recentRepo])
    listing.worktrees.push(resolved('repo-3::/external', recentRepo, 'local'))
    writeSettings({ worktreeVisibilityDefaults: { external: 'hide' } })
    const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(Object.keys(phone.view().workspaces)).not.toContain('local|repo-3::/external')

    writeSettings({ worktreeVisibilityDefaults: { external: 'show' } })
    await vi.advanceTimersByTimeAsync(60)
    const notice = events.findLast((event) => event.type === 'sidebarInputsChanged')
    if (notice?.type !== 'sidebarInputsChanged') {
      throw new Error('no change notice')
    }
    phone.notice(notice)
    await phone.settle()
    expect(Object.keys(phone.view().workspaces)).toContain('local|repo-3::/external')
    phone.disconnect()
  })

  it('reads past the shared listing cache and leaves it alone', async () => {
    const { runtime, rows, listing } = setup()
    const key = 'local|repo-1::/r/a'
    const cachedPinned = async (): Promise<boolean | undefined> =>
      (await runtime.cachedListing()).worktrees[0]?.isPinned
    expect(await cachedPinned()).toBe(false)
    listing.worktrees[0] = { ...listing.worktrees[0], isPinned: true }
    expect((await rows.snapshot()).rows[key]?.isPinned).toBe(true)
    // worktree.ps and the temporal owner keep reading the listing they cached.
    expect(await cachedPinned()).toBe(false)
  })

  it('reaches the phone feed as the workspaces domain', async () => {
    const { runtime, listing, write } = setup()
    const feed = requireSwitchedOn(runtime.sidebarInputsFeed)
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))
    const phone = new TestPhone(feed, 'conn-1')
    phone.refresh()
    await phone.settle()
    expect(Object.keys(phone.view().workspaces)).toEqual([
      'local|repo-1::/r/a',
      'ssh:box|repo-2::/remote/b'
    ])

    listing.worktrees[0] = { ...listing.worktrees[0], isPinned: true }
    write(['worktreeMeta'])
    await vi.advanceTimersByTimeAsync(60)
    const notice = events.findLast((event) => event.type === 'sidebarInputsChanged')
    if (notice?.type !== 'sidebarInputsChanged') {
      throw new Error('no change notice')
    }
    phone.notice(notice)
    await phone.settle()
    expect(phone.replies.at(-1)).toMatchObject({
      kind: 'delta',
      domains: { workspaces: { upserts: { 'local|repo-1::/r/a': { isPinned: true } } } }
    })
    expect(Object.keys(phone.replies.at(-1)?.domains.workspaces.upserts ?? {})).toEqual([
      'local|repo-1::/r/a'
    ])
    phone.disconnect()
  })
})

describe('current saved lineage at real Store boundaries', () => {
  async function withStore(run: (store: ReturnType<typeof createStore>) => Promise<void>) {
    vi.useRealTimers()
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-b-lineage-'))
    const store = createStore()
    try {
      await run(store)
    } finally {
      await closeTestStores()
      rmSync(testState.dir, { recursive: true, force: true })
    }
  }
  it('acquires final facts after listing, publishes current validity, and holds a real canonical fallback competitor', async () =>
    withStore(async (store) => {
      const owner = makeRepo({ id: 'repo-1', path: '/r', externalWorktreeVisibility: 'show' })
      const copyRepo = makeRepo({
        id: 'copy',
        path: '/copy',
        connectionId: 'copy',
        executionHostId: 'ssh:copy'
      })
      store.addRepo(owner)
      const c = { ...resolved('repo-1::/r/c', owner, 'local'), instanceId: 'c' }
      const p = { ...resolved('repo-1::/r/p', owner, 'local'), instanceId: 'p' }
      for (const row of [c, p]) {
        store.setWorktreeMeta(hostWorktreeTarget(row), { instanceId: row.instanceId })
      }
      const edge = makeWorktreeLineage({
        worktreeId: c.id,
        worktreeInstanceId: 'c',
        parentWorktreeId: 'old::/gone',
        parentWorktreeInstanceId: 'p'
      })
      store.setWorktreeLineage(hostWorktreeTarget(c), edge)
      let release = Promise.withResolvers<ResolvedWorktreeSnapshot>()
      const producer = new WorkspaceRowsProducer({
        store,
        onClientEvent: () => () => {},
        listVisibleWorktrees: () => release.promise
      })
      expect(projectCurrentStoreWorktreeLineage(store, [c, p])[0].parentWorktreeId).toBe(p.id)
      const pending = producer.snapshot()
      store.addRepo(copyRepo)
      const qid = 'copy::/copy'
      store.setWorktreeMeta(hostWorktreeTarget({ id: qid, hostId: 'local' }), {
        instanceId: 'other'
      })
      store.setWorktreeMeta(hostWorktreeTarget({ id: qid, hostId: 'ssh:copy' }), {
        instanceId: 'p'
      })
      release.resolve({
        worktrees: projectCurrentStoreWorktreeLineage(store, [c, p]),
        platformByRepoId: new Map()
      })
      const result = await pending
      expect(result.rows[`local|${c.id}`]).toMatchObject({ lineage: null, savedLineage: edge })
      const q = buildDetectedGitWorktrees(store, copyRepo, [
        { path: '/copy', head: '', branch: '', isBare: false, isMainWorktree: true }
      ])
      expect(q[0]).toMatchObject({ id: qid, hostId: 'ssh:copy', instanceId: 'p' })
      const held = Object.entries(result.rows).flatMap(
        ([key, value]) => readFeedWorkspaceRow(key, value)?.worktree ?? []
      )
      const graph = getWorktreeLineageProjection(
        {},
        getWorkspaceLineageRows({ held: [...held, ...q] })
      )
      expect(graph.parents.size).toBe(0)
      store.removeWorktreeMeta(hostWorktreeTarget({ id: qid, hostId: 'ssh:copy' }))
      release = Promise.withResolvers<ResolvedWorktreeSnapshot>()
      release.resolve({
        worktrees: projectCurrentStoreWorktreeLineage(store, [c, p]),
        platformByRepoId: new Map()
      })
      const recovered = await producer.snapshot()
      expect(recovered.rows[`local|${c.id}`].lineage).toMatchObject({
        parentWorktreeId: 'old::/gone'
      })
      const recoveredHeld = Object.entries(recovered.rows).flatMap(
        ([key, value]) => readFeedWorkspaceRow(key, value)?.worktree ?? []
      )
      expect(
        [
          ...getWorktreeLineageProjection(
            {},
            getWorkspaceLineageRows({ held: recoveredHeld })
          ).parents.values()
        ].map((row) => row.id)
      ).toEqual([p.id])
    }))
  it('keeps unchanged warm reads cheap and reflects actual set/change/clear actions without accepting a rotated selection', async () =>
    withStore(async (store) => {
      const owner = makeRepo({ id: 'repo-1', path: '/r', externalWorktreeVisibility: 'show' })
      store.addRepo(owner)
      const input = ['c', 'p', 'q'].map((id) => ({
        ...resolved(`repo-1::/r/${id}`, owner, 'local'),
        instanceId: id,
        ...(id === 'c' ? {} : { cliProvenance: { kind: 'created-by-cli' as const, createdAt: 0 } })
      }))
      for (const row of input.slice(1)) {
        store.setWorktreeMeta(hostWorktreeTarget(row), {
          instanceId: row.instanceId,
          cliProvenance: row.cliProvenance
        })
      }
      store.updateUI({ hideCliCreatedWorkspaces: true })
      const scan = vi.fn(async () => ({
        ok: true as const,
        worktrees: input.map((row) => ({ ...row.git, path: row.path }))
      }))
      const inventory = vi.fn(async () => null)
      class Probe extends OrcaRuntimeService {
        protected override async refreshPtyWorktreeRecordsFromController() {
          return inventory()
        }
        protected override async listRepoWorktreesForListing(repo: Repo) {
          return repo.id === owner.id ? scan() : { ok: false as const, worktrees: [] }
        }
        protected override async resolveExplicitWorktreeIdScoped(id: string) {
          return (
            (await this.computeResolvedWorktrees()).worktrees.find((row) => row.id === id) ?? null
          )
        }
        cached() {
          return this.listResolvedWorktreeSnapshot()
        }
        terminalTarget(selector: string) {
          return this.resolveTerminalWorkspaceLaunchTarget(selector)
        }
      }
      const runtime = new Probe(store)
      const read = vi.spyOn(store, 'getWorktreeLineageMetadata')
      const backfilled = await runtime.cached()
      const childInstanceId = store.getWorktreeMeta(input[0].id)?.instanceId
      expect(childInstanceId).toBeTruthy()
      input[0].instanceId = childInstanceId ?? ''
      const warm = await runtime.cached()
      expect(warm.worktrees).not.toBe(backfilled.worktrees)
      expect(scan).toHaveBeenCalledTimes(2)
      const summaries = async () => {
        const publication = await runtime.cached()
        return buildRuntimeWorktreePsSummaries({
          store,
          resolvedWorktrees: publication.worktrees,
          folderWorktrees: publication.folderWorktrees,
          platformByRepoId: publication.platformByRepoId
        })
      }
      const hidden = (id: string) =>
        isWorkspaceHiddenBySidebarFilters(
          { store, resolvedWorktrees: warm.worktrees },
          `repo-1::/r/${id}`
        )
      const count = read.mock.calls.length
      const scans = scan.mock.calls.length
      expect((await runtime.cached()).worktrees).toBe(warm.worktrees)
      expect(read).toHaveBeenCalledTimes(count)
      expect(scan).toHaveBeenCalledTimes(scans)
      for (const id of ['p', 'q']) {
        await runtime.updateManagedWorktreeMeta(`id:${input[0].id}`, {
          lineage: {
            parentWorktreeRef: { worktreeId: `repo-1::/r/${id}`, instanceId: id, external: false }
          }
        })
        expect((await runtime.showManagedWorktree(`id:${input[0].id}`)).parentWorktreeId).toBe(
          `repo-1::/r/${id}`
        )
        expect((await summaries()).get(input[0].id)?.parentWorktreeId).toBe(`repo-1::/r/${id}`)
        expect(hidden(id)).toBe(false)
        expect(hidden(id === 'p' ? 'q' : 'p')).toBe(true)
      }
      await runtime.updateManagedWorktreeMeta(`id:${input[0].id}`, { lineage: { noParent: true } })
      expect((await runtime.showManagedWorktree(`id:${input[0].id}`)).savedLineage).toBeNull()
      expect((await summaries()).get(input[0].id)).toMatchObject({
        parentWorktreeId: null,
        savedLineage: null
      })
      expect([hidden('p'), hidden('q')]).toEqual([true, true])
      store.setWorktreeMeta(hostWorktreeTarget(input[0]), { comment: 'task_hydrate' })
      const beforeHydration = await runtime.cached()
      const hydration = new RuntimeWorktreeLineageController({
        getStore: () => store,
        getDb: () => null,
        listResolvedWorktrees: async () => (await runtime.cached()).worktrees,
        resolveWorktree: async () => input[1],
        showTerminal: async () => ({ worktreeId: input[1].id })
      })
      vi.spyOn(hydration, 'resolveTaskCandidate').mockResolvedValue({
        source: 'orchestration-context',
        parent: {
          type: 'worktree',
          workspaceKey: worktreeWorkspaceKey(input[1].id),
          worktree: input[1],
          instanceId: 'p'
        }
      })
      await hydration.hydrate()
      expect((await summaries()).get(input[0].id)?.parentWorktreeId).toBe(input[1].id)
      expect((await runtime.cached()).worktrees).not.toBe(beforeHydration.worktrees)
      await runtime.updateManagedWorktreeMeta(`id:${input[0].id}`, { lineage: { noParent: true } })
      store.setWorktreeMeta(hostWorktreeTarget(input[0]), { comment: '' })
      const group = store.createProjectGroup({
        name: 'Folders',
        parentPath: testState.dir,
        createdFrom: 'folder-scan'
      })
      const folder = store.createFolderWorkspace({ projectGroupId: group.id, name: 'Child' })
      const folderEdge = store.setWorkspaceLineage({
        childWorkspaceKey: folderWorkspaceKey(folder.id),
        childInstanceId: folderWorkspaceKey(folder.id),
        parentWorkspaceKey: worktreeWorkspaceKey('old::/renamed'),
        parentInstanceId: 'p',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 1
      })
      const folderPublication = await runtime.cached()
      expect(folderPublication.worktrees.map((row) => row.id)).toEqual(input.map((row) => row.id))
      expect(folderPublication.folderWorktrees?.map((row) => row.id)).toEqual([
        folderWorkspaceKey(folder.id)
      ])
      const folderReads = read.mock.calls.length
      const folderScans = scan.mock.calls.length
      expect((await runtime.cached()).worktrees).toBe(folderPublication.worktrees)
      expect((await runtime.cached()).folderWorktrees).toBe(folderPublication.folderWorktrees)
      const folderSummary = (await summaries()).get(folderWorkspaceKey(folder.id))
      expect(read).toHaveBeenCalledTimes(folderReads)
      expect(scan).toHaveBeenCalledTimes(folderScans)
      expect(folderSummary).toMatchObject({
        parentWorktreeId: input[1].id,
        savedLineage: { parentWorktreeId: 'old::/renamed', parentWorktreeInstanceId: 'p' }
      })
      expect((await summaries()).get(input[1].id)?.childWorktreeIds).toContain(
        folderWorkspaceKey(folder.id)
      )
      const target = await runtime.terminalTarget(folderWorkspaceKey(folder.id))
      expect(target.scope).toMatchObject({
        id: folderWorkspaceKey(folder.id),
        path: folder.folderPath,
        connectionId: null
      })
      expect(target.managedWorktree).toMatchObject({ parentWorktreeId: input[1].id })
      const enteredInventory = Promise.withResolvers<void>()
      const resumeInventory = Promise.withResolvers<void>()
      inventory.mockImplementationOnce(async () => {
        enteredInventory.resolve()
        await resumeInventory.promise
        return null
      })
      const pendingPs = runtime.getWorktreePs()
      await enteredInventory.promise
      store.removeWorktreeLineage(
        hostWorktreeTarget({ id: folderWorkspaceKey(folder.id), hostId: 'local' })
      )
      resumeInventory.resolve()
      const clearedPs = await pendingPs
      expect(
        clearedPs.worktrees.find((row) => row.worktreeId === folderWorkspaceKey(folder.id))
      ).toMatchObject({ parentWorktreeId: null, savedLineage: null })
      expect(
        clearedPs.worktrees.find((row) => row.worktreeId === input[1].id)?.childWorktreeIds
      ).not.toContain(folderWorkspaceKey(folder.id))
      const afterInventoryReads = read.mock.calls.length
      const afterInventoryScans = scan.mock.calls.length
      await runtime.getWorktreePs()
      expect(read).toHaveBeenCalledTimes(afterInventoryReads)
      expect(scan).toHaveBeenCalledTimes(afterInventoryScans)
      store.setWorkspaceLineage(folderEdge)
      const resumeScan = Promise.withResolvers<void>()
      scan.mockImplementationOnce(async () => {
        await resumeScan.promise
        return {
          ok: true as const,
          worktrees: input.map((row) => ({ ...row.git, path: row.path }))
        }
      })
      store.updateFolderWorkspace(folder.id, { name: 'Renamed child', comment: 'live metadata' })
      const pendingPublication = runtime.cached()
      const copyRepo = makeRepo({ id: 'copy', path: '/copy', connectionId: 'copy' })
      store.addRepo(copyRepo)
      const competitor = hostWorktreeTarget({ id: 'copy::/copy', hostId: 'ssh:copy' })
      store.setWorktreeMeta(competitor, { instanceId: 'p', isArchived: true })
      resumeScan.resolve()
      const withCompetitor = await pendingPublication
      expect(withCompetitor.folderWorktrees?.[0]).toMatchObject({
        parentWorktreeId: null,
        savedLineage: { parentWorktreeInstanceId: 'p' }
      })
      const duringCopy = (await summaries()).get(folderWorkspaceKey(folder.id))
      expect(duringCopy).toMatchObject({
        parentWorktreeId: null,
        displayName: 'Renamed child',
        comment: 'live metadata'
      })
      store.removeWorktreeMeta(competitor)
      expect((await summaries()).get(folderWorkspaceKey(folder.id))?.parentWorktreeId).toBe(
        input[1].id
      )
      store.setWorktreeMeta(hostWorktreeTarget(input[1]), { instanceId: 'replacement' })
      expect(
        (await runtime.terminalTarget(folderWorkspaceKey(folder.id))).managedWorktree
      ).toMatchObject({
        parentWorktreeId: null
      })
      await expect(
        runtime.updateManagedWorktreeMeta(`id:${input[0].id}`, {
          lineage: {
            parentWorktreeRef: { worktreeId: input[1].id, instanceId: 'p', external: false }
          }
        })
      ).rejects.toThrow('changed')
      expect(store.getWorktreeLineage(input[0].id)).toBeUndefined()
      // The listing fixture now discovers the replacement; stale selections above still refuse.
      input[1].instanceId = 'replacement'
      expect((await summaries()).get(folderWorkspaceKey(folder.id))).toMatchObject({
        parentWorktreeId: null,
        savedLineage: { parentWorktreeId: 'old::/renamed', parentWorktreeInstanceId: 'p' }
      })
      store.setWorktreeMeta(hostWorktreeTarget(input[1]), { instanceId: 'p' })
      input[1].instanceId = 'p'
      const pendingParent = Promise.withResolvers<ResolvedWorktree>()
      const validateParent = vi.fn()
      const changing = updateRuntimeManagedWorktreeMetadata({
        selector: `id:${input[0].id}`,
        updates: {
          lineage: {
            parentWorktreeRef: { worktreeId: input[1].id, instanceId: 'p', external: false }
          }
        },
        store,
        ports: {
          resolveWorktree: async (selector) =>
            selector === `id:${input[0].id}` ? input[0] : pendingParent.promise,
          validateParent,
          invalidateResolved: () => {},
          invalidateScan: () => {},
          notifyChanged: () => {},
          showWorktree: async () => input[0]
        }
      })
      await Promise.resolve()
      store.setWorktreeMeta(hostWorktreeTarget(input[0]), { instanceId: 'new-child' })
      pendingParent.resolve(input[1])
      await expect(changing).rejects.toThrow('changed')
      expect(validateParent).not.toHaveBeenCalled()
      expect(store.getWorktreeLineage(input[0].id)).toBeUndefined()
    }))
})
