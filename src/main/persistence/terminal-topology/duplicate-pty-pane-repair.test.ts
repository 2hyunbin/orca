import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../agent-hooks/server'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { repairDuplicatePtyPanesOnStart } from '../../runtime/moved-pane-owner-rekey'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { DelayedAuthority } from '../loading-store/profile-state-delayed-authority-fixture'
import { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { planDuplicatePtyPaneRepair } from './duplicate-pty-pane-repair'
import { leafIds, WindowSession } from './terminal-topology-window-session-fixture'
import {
  emptyTerminalSessionProfile,
  FIXTURE_GIT_WORKTREE_ID
} from './terminal-topology-profile-fixture'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

const TAB = 'tab-1'
const KEPT = '11111111-1111-4111-8111-111111111111'
const DUPLICATE = '22222222-2222-4222-8222-222222222222'
const directories: string[] = []
const stores: Store[] = []

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.freezeWritesAsync()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

/** The stored shape a window save leaves behind: one terminal drawn in two panes of one tab. */
function duplicateSession(): WorkspaceSessionState {
  const window = new WindowSession(getDefaultWorkspaceSession())
  window.addTab(FIXTURE_GIT_WORKTREE_ID, TAB, KEPT)
  window.setLayout(
    TAB,
    {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: KEPT },
      second: { type: 'leaf', leafId: DUPLICATE }
    },
    { [KEPT]: 'pty-1', [DUPLICATE]: 'pty-1' }
  )
  return window.session
}

function seededDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-duplicate-pty-repair-'))
  directories.push(directory)
  const inner = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  inner.writeSerializedState(
    Buffer.from(
      JSON.stringify({
        ...JSON.parse(emptyTerminalSessionProfile()),
        workspaceSession: duplicateSession()
      })
    )
  )
  inner.close()
  return directory
}

async function load(directory: string): Promise<{ store: Store; authority: DelayedAuthority }> {
  const authority = new DelayedAuthority(
    new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  )
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  stores.push(store)
  await store.flushPendingOrThrowAsync()
  return { store, authority }
}

async function quit(store: Store): Promise<void> {
  await store.flushPendingOrThrowAsync()
  await store.freezeWritesAsync()
  stores.splice(stores.indexOf(store), 1)
}

function storedLayouts(directory: string): string {
  const reader = new ProfileStateSqliteAuthority(join(directory, 'profile-state.db'), 'topology')
  try {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test wrote this profile as PersistedState.
    const state = JSON.parse(reader.readSerializedState() ?? '{}') as PersistedState
    return JSON.stringify(state.workspaceSession?.terminalLayoutsByTabId ?? null)
  } finally {
    reader.close()
  }
}

function storedLeafIds(directory: string): string[] {
  return leafIds(JSON.parse(storedLayouts(directory))?.[TAB]?.root)
}

function fakeRuntime() {
  const rekeyWorkerTerminalResourcePaneKey = vi.fn(() => 1)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the repair reads only the orchestration DB accessor.
  const runtime = {
    getExistingOrchestrationDb: () => ({ rekeyWorkerTerminalResourcePaneKey })
  } as unknown as OrcaRuntimeService
  return { runtime, rekeyWorkerTerminalResourcePaneKey }
}

function workspaceSessionWrites(authority: DelayedAuthority): number {
  return authority.captures.filter((writes) =>
    writes.some((write) => JSON.stringify(write).includes('workspaceSession'))
  ).length
}

describe('duplicate-terminal pane repair at load (layout-owner builds)', () => {
  it('moves the dropped pane’s agent status and orchestration row, then writes one pane', async () => {
    const directory = seededDirectory()
    const { store } = await load(directory)
    const diskAtTransfer: string[][] = []
    const transfer = vi
      .spyOn(agentHookServer, 'transferPaneAuthority')
      .mockImplementation(() => diskAtTransfer.push(storedLeafIds(directory)))
    const { runtime, rekeyWorkerTerminalResourcePaneKey } = fakeRuntime()

    await repairDuplicatePtyPanesOnStart(store, runtime)

    expect(transfer).toHaveBeenCalledExactlyOnceWith(
      `${TAB}:${DUPLICATE}`,
      `${TAB}:${KEPT}`,
      'pty-1',
      expect.any(Number),
      { authorityVerified: true }
    )
    expect(rekeyWorkerTerminalResourcePaneKey).toHaveBeenCalledExactlyOnceWith({
      fromPaneKey: `${TAB}:${DUPLICATE}`,
      toPaneKey: `${TAB}:${KEPT}`
    })
    // The status moved while disk still held both panes.
    expect(diskAtTransfer).toEqual([[KEPT, DUPLICATE]])
    await quit(store)
    expect(storedLeafIds(directory)).toEqual([KEPT])
    expect(JSON.parse(storedLayouts(directory))[TAB].ptyIdsByLeafId).toEqual({ [KEPT]: 'pty-1' })
  })

  it('leaves disk alone with no runtime, then a runtime start transfers and writes once', async () => {
    const directory = seededDirectory()
    const seeded = storedLayouts(directory)
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})

    // A load no runtime starts on (a CLI-only read): it reads the repair, never writes it.
    const cliOnly = await load(directory)
    await quit(cliOnly.store)
    expect(storedLayouts(directory)).toBe(seeded)
    expect(transfer).not.toHaveBeenCalled()

    const started = await load(directory)
    started.authority.captures.length = 0
    const { runtime, rekeyWorkerTerminalResourcePaneKey } = fakeRuntime()
    await repairDuplicatePtyPanesOnStart(started.store, runtime)

    expect(transfer).toHaveBeenCalledOnce()
    expect(rekeyWorkerTerminalResourcePaneKey).toHaveBeenCalledOnce()
    expect(workspaceSessionWrites(started.authority)).toBe(1)
    expect(storedLeafIds(directory)).toEqual([KEPT])
  })

  it('neither transfers nor writes on a frozen or imported Store', async () => {
    const directory = seededDirectory()
    const seeded = storedLayouts(directory)
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    const { store } = await load(directory)
    await store.freezeWritesAsync()
    const imported = new Store({
      serializedState: JSON.stringify({
        ...JSON.parse(emptyTerminalSessionProfile()),
        workspaceSession: duplicateSession()
      })
    })

    await repairDuplicatePtyPanesOnStart(store, fakeRuntime().runtime)
    await repairDuplicatePtyPanesOnStart(imported, fakeRuntime().runtime)

    expect(transfer).not.toHaveBeenCalled()
    expect(storedLayouts(directory)).toBe(seeded)
    expect(leafIds(imported.getWorkspaceSession().terminalLayoutsByTabId[TAB]?.root)).toEqual([
      KEPT,
      DUPLICATE
    ])
  })

  it('is a no-op on the next start', async () => {
    const directory = seededDirectory()
    const first = await load(directory)
    const transfer = vi.spyOn(agentHookServer, 'transferPaneAuthority').mockImplementation(() => {})
    await repairDuplicatePtyPanesOnStart(first.store, fakeRuntime().runtime)
    await quit(first.store)
    transfer.mockClear()
    const repaired = storedLayouts(directory)

    const second = await load(directory)
    second.authority.captures.length = 0
    await expect(second.store.repairDuplicatePtyPanes(() => {})).resolves.toBe(0)

    expect(transfer).not.toHaveBeenCalled()
    expect(workspaceSessionWrites(second.authority)).toBe(0)
    expect(storedLayouts(directory)).toBe(repaired)
  })
})

describe('planDuplicatePtyPaneRepair', () => {
  it('repairs the layout but keeps the owner when another tab also binds the terminal', () => {
    const session = duplicateSession()
    session.terminalLayoutsByTabId['tab-2'] = {
      root: { type: 'leaf', leafId: '33333333-3333-4333-8333-333333333333' },
      activeLeafId: '33333333-3333-4333-8333-333333333333',
      expandedLeafId: null,
      ptyIdsByLeafId: { '33333333-3333-4333-8333-333333333333': 'pty-1' }
    }

    const plan = planDuplicatePtyPaneRepair(session)

    expect(leafIds(plan?.session.terminalLayoutsByTabId[TAB]?.root)).toEqual([KEPT])
    expect(plan?.transfers).toEqual([])
  })
})
