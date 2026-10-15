import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { LEGACY_WORKSPACE_LAYOUT_PROFILES } from '../../../shared/workspace-layout/workspace-layout-legacy-profile.test-fixture'
import { emptySession } from '../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { rewriteStoredLayoutsAtStartup } from './startup-layout-rewrite'

const fixture = (
  name: string,
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): WorkspaceSessionState =>
  JSON.parse(
    JSON.stringify(
      LEGACY_WORKSPACE_LAYOUT_PROFILES.find((profile) => profile.name === name)!.build()
    ).replaceAll('"executionHostId":"local"', `"executionHostId":${JSON.stringify(hostId)}`)
  )
const ADOPTABLE = 'row without a tab-bar entry, still bound to a terminal'
const GHOST = 'row without a tab-bar entry or a terminal'
const SSH = toSshExecutionHostId('build-host')
const FENCED = toSshExecutionHostId('fenced-host')
const SERVER = toRuntimeExecutionHostId('env-1')

function state() {
  const persisted = getDefaultPersistedState('/home/dev')
  persisted.workspaceSession = emptySession()
  persisted.workspaceSessionsByHostId = {
    [SSH]: fixture(ADOPTABLE, SSH),
    [FENCED]: fixture(ADOPTABLE, FENCED),
    [SERVER]: fixture(GHOST, SERVER)
  }
  persisted.sshTargets = [
    { id: 'build-host', label: 'b', host: 'b.test', port: 22, username: 'u', source: 'manual' },
    {
      id: 'fenced-host',
      label: 'f',
      host: 'f.test',
      port: 22,
      username: 'u',
      source: 'manual',
      orcadFence: { environmentId: 'env-2' }
    }
  ]
  return persisted
}

describe('rewriteStoredLayoutsAtStartup', () => {
  it('rewrites proven-neutral partitions and keeps the rest as stored', () => {
    const persisted = state()
    const before = structuredClone(persisted)
    expect(rewriteStoredLayoutsAtStartup(persisted)).toEqual({
      rewritten: [SSH],
      skipped: [{ hostId: SERVER, reason: 'terminalEntry.*' }]
    })
    expect(persisted.workspaceSession).toEqual(before.workspaceSession)
    expect(Object.values(persisted.workspaceSessionsByHostId![SSH]!.unifiedTabs!)[0]).toHaveLength(
      2
    )
    // A fenced host's partition is migration source and stays byte-identical.
    expect(persisted.workspaceSessionsByHostId![FENCED]).toEqual(
      before.workspaceSessionsByHostId![FENCED]
    )
    expect(persisted.workspaceSessionsByHostId![SERVER]).toEqual(
      before.workspaceSessionsByHostId![SERVER]
    )
  })

  it('rewrites the local partition and is a no-op on its own output', () => {
    const persisted = state()
    persisted.workspaceSession = fixture(ADOPTABLE)
    persisted.workspaceSessionsByHostId = {}
    expect(rewriteStoredLayoutsAtStartup(persisted).rewritten).toEqual([LOCAL_EXECUTION_HOST_ID])
    expect(rewriteStoredLayoutsAtStartup(persisted)).toEqual({ rewritten: [], skipped: [] })
  })
})
