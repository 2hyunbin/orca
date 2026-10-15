import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../shared/constants'
import type { PersistedState } from '../../shared/persisted-state-types'
import type { SshRemotePtyLease, SshTarget } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { closeTestStores, createSqliteTestStore } from '../persistence-test-harness'
import { Store } from '../persistence/loading-store/store'
import { fenceOrcadMigrationSource } from './orcad-migration-source-fence'
import {
  assessOrcadMigrationTerminals,
  retireProvenExitedLeases,
  type HostRelayTerminalProof
} from './orcad-migration-terminal-gate'
import { SshTargetOrcadClaims } from './ssh-target-orcad-claims'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import { listOrcadMigrationSourceCutovers } from './orcad-migration-cutover-journal'
import { onlyLeavableOrcadMigrationBlockers } from './ssh-target-orcad-preflight'

// Relay-era profiles as the reporters' builds left them, loaded by the real Store and taken through
// the conversion's source steps: terminal proof, lease retirement, then the fence and its preflight.

const TARGET: SshTarget = {
  id: 'ssh-wsl',
  label: 'wsl',
  host: '127.0.0.1',
  port: 22,
  username: 'dev',
  generation: 1
}
const HOST = `ssh:${TARGET.id}`
const LEAF = '11111111-1111-4111-8111-111111111111'

const directories: string[] = []
afterEach(async () => {
  await closeTestStores()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function relayEraProfile(projects: number): PersistedState {
  const state = getDefaultPersistedState('/home/dev')
  state.sshTargets = [TARGET]
  state.repos = Array.from({ length: projects }, (_, index) => ({
    id: `repo-${index}`,
    path: `/home/dev/src/project-${index}`,
    displayName: `project-${index}`,
    badgeColor: '#737373',
    addedAt: 1,
    kind: 'git' as const,
    connectionId: TARGET.id
  }))
  state.workspaceSessionsByHostId = { [HOST]: getDefaultWorkspaceSession() }
  return state
}

/** One terminal tab, as the unified model and the legacy map both hold it. */
function openTerminal(session: WorkspaceSessionState, worktreeId: string, tabId: string): void {
  session.tabsByWorktree[worktreeId] = [
    {
      id: tabId,
      ptyId: null,
      worktreeId,
      title: 'bash',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  ]
  session.terminalLayoutsByTabId[tabId] = {
    root: { type: 'leaf', leafId: LEAF },
    activeLeafId: LEAF,
    expandedLeafId: null
  }
  session.unifiedTabs = {
    ...session.unifiedTabs,
    [worktreeId]: [
      {
        id: tabId,
        entityId: tabId,
        groupId: `group-${tabId}`,
        worktreeId,
        contentType: 'terminal',
        label: 'bash',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
  session.tabGroups = {
    ...session.tabGroups,
    [worktreeId]: [{ id: `group-${tabId}`, worktreeId, activeTabId: tabId, tabOrder: [tabId] }]
  }
}

function load(profile: PersistedState) {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orcad-stuck-host-'))
  directories.push(userDataPath)
  const dataFile = join(userDataPath, 'orca-data.json')
  writeFileSync(dataFile, JSON.stringify(profile))
  const store = createSqliteTestStore(Store, { dataFile })
  return { userDataPath, store, claims: new SshTargetOrcadClaims(store) }
}

/** The connect's own sequence: prove the host's terminals, retire what that proves, then fence. */
async function connectMove(
  loaded: ReturnType<typeof load>,
  census: HostRelayTerminalProof = { verdict: 'exited', count: 0 }
) {
  const proof = await assessOrcadMigrationTerminals(loaded.store, TARGET.id, async () => census)
  if (proof.verdict === 'live' || proof.verdict === 'unverifiable') {
    return { outcome: 'refused', reason: proof.reason }
  }
  retireProvenExitedLeases(loaded.store, TARGET.id, proof)
  return fenceOrcadMigrationSource({
    userDataPath: loaded.userDataPath,
    store: loaded.store,
    claims: loaded.claims,
    targetId: TARGET.id,
    destinationEnvironmentId: 'env-managed',
    destinationName: 'wsl',
    terminalProof: proof
  })
}

describe('a phone user upgrading every SSH host (WeChat report)', () => {
  function phoneUserProfile(): PersistedState {
    const state = relayEraProfile(2)
    const host = state.workspaceSessionsByHostId![HOST]!
    const worktreeId = 'repo-0::/home/dev/src/project-0'
    openTerminal(host, worktreeId, 'tab-1')
    // A browser tab the runtime opened, or one switched back to Default.
    host.browserTabsByWorktree = {
      [worktreeId]: [
        {
          id: 'browser-1',
          worktreeId,
          url: 'https://example.test/',
          title: 'Example',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 1,
          sessionProfileId: null,
          sessionPartition: 'persist:orca-browser'
        }
      ]
    }
    state.mobileClientTabSelectionsByDeviceId = {
      // The runtime names a phone's terminal by its pane.
      phone: {
        [worktreeId]: {
          activeTabId: `tab-1::${LEAF}`,
          activeGroupId: 'group-tab-1',
          activeTabIdByGroupId: { 'group-tab-1': 'tab-1' }
        }
      },
      tablet: {
        [worktreeId]: { activeTabId: 'closed-tab', activeGroupId: null, activeTabIdByGroupId: {} }
      }
    }
    return state
  }

  it('moves the host and keeps the phone on its pane', async () => {
    const loaded = load(phoneUserProfile())
    const result = await connectMove(loaded)
    expect(result).toMatchObject({ outcome: 'fenced' })
    if (!('cutover' in result)) {
      return
    }
    const clientState = result.cutover.manifest.payload.dormantState?.clientState
    expect(clientState?.mobileClientTabSelectionsByDeviceId).toEqual({
      phone: {
        'repo-0::/home/dev/src/project-0': {
          activeTabId: `tab-1::${LEAF}`,
          activeGroupId: 'group-tab-1',
          activeTabIdByGroupId: { 'group-tab-1': 'tab-1' }
        }
      }
    })
  })
})

describe('#29083: about 14 projects, folders, a saved session and relay-era leases', () => {
  function reportedProfile(): PersistedState {
    const state = relayEraProfile(14)
    state.projectGroups = [
      {
        id: 'group-folders',
        name: 'folders',
        parentPath: '/home/dev/notes',
        connectionId: TARGET.id,
        createdFrom: 'manual',
        createdAt: 1
      } as PersistedState['projectGroups'][number]
    ]
    state.folderWorkspaces = ['notes', 'scratch', 'docs'].map((name) => ({
      id: `folder-${name}`,
      projectGroupId: 'group-folders',
      name,
      folderPath: `/home/dev/notes/${name}`,
      connectionId: TARGET.id,
      createdAt: 1
    })) as PersistedState['folderWorkspaces']
    const host = state.workspaceSessionsByHostId![HOST]!
    for (const index of [0, 3, 7]) {
      openTerminal(host, `repo-${index}::/home/dev/src/project-${index}`, `tab-${index}`)
    }
    openTerminal(host, 'folder:folder-notes', 'tab-notes')
    const lease = (ptyId: string, state: SshRemotePtyLease['state']): SshRemotePtyLease => ({
      targetId: TARGET.id,
      ptyId,
      worktreeId: 'repo-0::/home/dev/src/project-0',
      tabId: 'tab-0',
      leafId: LEAF,
      state,
      createdAt: 1,
      updatedAt: 1
    })
    // A 1.4.224 that was killed with terminals open never got to detach them.
    state.sshRemotePtyLeases = [
      lease('pty-attached-1', 'attached'),
      lease('pty-attached-2', 'attached'),
      lease('pty-detached', 'detached'),
      lease('pty-expired', 'expired')
    ]
    return state
  }

  it('moves once the host proves no relay is left, folders and tabs included', async () => {
    const loaded = load(reportedProfile())
    const result = await connectMove(loaded)
    expect(result).toMatchObject({ outcome: 'fenced' })
    if (!('cutover' in result)) {
      return
    }
    const payload = result.cutover.manifest.payload
    expect(payload.repositories).toHaveLength(14)
    expect(payload.folderWorkspaces.map((folder) => folder.id).sort()).toEqual([
      'folder-docs',
      'folder-notes',
      'folder-scratch'
    ])
    expect(Object.keys(payload.dormantState?.workspaceSession?.tabsByWorktree ?? {})).toHaveLength(
      4
    )
    expect(
      loaded.store.getSshRemotePtyLeases(TARGET.id).every((entry) => entry.state === 'terminated')
    ).toBe(true)
  })

  it('still converts through the bridge when old relays may run, retiring nothing', async () => {
    const loaded = load(reportedProfile())
    const result = await connectMove(loaded, { verdict: 'live', count: 2 })
    expect(result).toMatchObject({ outcome: 'fenced' })
    expect(
      loaded.store
        .getSshRemotePtyLeases(TARGET.id)
        .filter((entry) => entry.state !== 'terminated')
        .map((entry) => entry.ptyId)
    ).toEqual(['pty-attached-1', 'pty-attached-2', 'pty-detached', 'pty-expired'])
  })
})

describe('"Move anyway"', () => {
  const worktreeId = 'repo-0::/home/dev/src/project-0'

  function savedStateOnly(): PersistedState {
    const state = relayEraProfile(1)
    const host = state.workspaceSessionsByHostId![HOST]!
    openTerminal(host, worktreeId, 'tab-1')
    host.openFilesByWorktree = {
      [worktreeId]: [
        {
          filePath: '/etc/hosts',
          relativePath: 'hosts',
          worktreeId,
          language: 'plaintext',
          externalSshTargetId: TARGET.id,
          dirtyDraftContent: 'unsaved edit'
        }
      ]
    }
    host.unifiedTabs![worktreeId]!.push({
      id: 'runtime-tab',
      entityId: 'runtime-tab',
      groupId: 'group-tab-1',
      worktreeId,
      executionHostId: 'runtime:env-other',
      contentType: 'terminal',
      label: 'elsewhere',
      customLabel: null,
      color: null,
      sortOrder: 1,
      createdAt: 1
    })
    // The desktop's older copy disagrees with the host's.
    state.workspaceSession.tabsByWorktree[worktreeId] = [
      { ...host.tabsByWorktree[worktreeId]![0]!, id: 'older-tab' }
    ]
    return state
  }

  it('is offered when only saved state blocks', async () => {
    const loaded = load(savedStateOnly())
    const result = await connectMove(loaded)
    expect(result).toMatchObject({ outcome: 'refused', code: 'orcad_migration_preflight_blocked' })
    expect('blockers' in result && onlyLeavableOrcadMigrationBlockers(result.blockers ?? [])).toBe(
      true
    )
    // A refused move leaves no fence or journal, so a downgraded build still connects as before.
    expect(getManagedOrcadFenceEnvironmentId(loaded.store.getSshTarget(TARGET.id))).toBeNull()
    expect(listOrcadMigrationSourceCutovers(loaded.userDataPath)).toEqual([])
  })

  it('moves what it can and leaves the rest in the retained profile', async () => {
    const loaded = load(savedStateOnly())
    loaded.store.updateSshTarget(TARGET.id, {
      managedServerLeaveBehind: { confirmedAt: '2026-10-15T00:00:00.000Z' }
    })
    const before = structuredClone(loaded.store.getWorkspaceSession(HOST))
    const result = await connectMove(loaded)
    expect(result).toMatchObject({ outcome: 'fenced' })
    if (!('cutover' in result)) {
      return
    }
    const session = result.cutover.manifest.payload.dormantState?.workspaceSession
    expect(session?.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(session?.unifiedTabs?.[worktreeId]?.map((tab) => tab.id)).toEqual(['tab-1'])
    expect(session?.openFilesByWorktree?.[worktreeId] ?? []).toEqual([])
    // Nothing is deleted: the draft and the older copy are still saved on this desktop.
    expect(loaded.store.getWorkspaceSession(HOST)).toEqual(before)
    expect(
      loaded.store.getWorkspaceSession().tabsByWorktree[worktreeId]?.map((tab) => tab.id)
    ).toEqual(['older-tab'])
  })

  it('never leaves a running terminal behind', async () => {
    const loaded = load(savedStateOnly())
    loaded.store.updateSshTarget(TARGET.id, {
      managedServerLeaveBehind: { confirmedAt: '2026-10-15T00:00:00.000Z' }
    })
    await expect(
      fenceOrcadMigrationSource({
        userDataPath: loaded.userDataPath,
        store: loaded.store,
        claims: loaded.claims,
        targetId: TARGET.id,
        destinationEnvironmentId: 'env-managed',
        destinationName: 'wsl',
        terminalProof: { verdict: 'live', ptyIds: ['pty-1'], reason: 'still running' }
      })
    ).resolves.toMatchObject({ outcome: 'refused', code: 'orcad_migration_terminals' })
  })
})
