import type * as RuntimeClientModule from '../runtime-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY } from '../../shared/runtime-capability-constants'

const { localCall, remoteCall } = vi.hoisted(() => ({ localCall: vi.fn(), remoteCall: vi.fn() }))
vi.mock('../runtime-client', async (original) => ({
  ...(await original<typeof RuntimeClientModule>()),
  RuntimeClient: class {
    isRemote: boolean
    call: typeof localCall
    constructor(
      _path?: string,
      _timeout?: number,
      _pairing?: string | null,
      environment?: string | null
    ) {
      this.isRemote = Boolean(environment)
      this.call = this.isRemote ? remoteCall : localCall
    }
  }
}))
import { RuntimeClient } from '../runtime-client'
import { WORKTREE_HANDLERS } from './worktree'

describe('remote worktree caller lineage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllEnvs()
    vi.stubEnv('ORCA_WORKSPACE_ID', '')
    vi.stubEnv('ORCA_WORKTREE_ID', '')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  const parent = {
    id: 'repo::/caller',
    instanceId: 'parent-instance',
    hostId: 'local',
    path: process.cwd()
  }
  const client = () => new RuntimeClient(undefined, undefined, null, 'target')
  const flags = () =>
    new Map<string, string | boolean>([
      ['repo', 'id:remote-repo'],
      ['name', 'child'],
      ['environment', 'target']
    ])
  function respond(capabilities: string[]) {
    localCall.mockImplementation(async (method) => ({
      result: method === 'worktree.list' ? { worktrees: [parent] } : { worktree: parent }
    }))
    remoteCall.mockImplementation(async (method) => ({
      result:
        method === 'status.get'
          ? { capabilities }
          : method === 'projectHostSetup.list'
            ? {
                setups: [
                  {
                    id: 'remote-setup',
                    projectId: 'project-1',
                    hostId: 'local',
                    repoId: 'remote-repo',
                    setupState: 'ready'
                  }
                ]
              }
            : { worktree: { id: 'remote::/child' } }
    }))
  }
  it('resolves an explicit caller parent locally and keeps a path parent on the target', async () => {
    respond([WORKTREE_CROSS_MACHINE_PARENT_RUNTIME_CAPABILITY])
    const explicit = flags().set('parent-worktree', 'active')
    await WORKTREE_HANDLERS['worktree create']({
      flags: explicit,
      cwd: process.cwd(),
      client: client(),
      json: true
    })
    expect(remoteCall).toHaveBeenLastCalledWith(
      'worktree.create',
      expect.objectContaining({
        parentWorktreeRef: {
          worktreeId: parent.id,
          instanceId: parent.instanceId,
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' }
        },
        callerTerminalHandle: undefined
      })
    )
    for (const projectFlags of [
      new Map<string, string | boolean>([
        ['project', 'project-1'],
        ['host', 'runtime:target'],
        ['name', 'child']
      ]),
      new Map<string, string | boolean>([
        ['project-host-setup', 'remote-setup'],
        ['name', 'child']
      ])
    ]) {
      await WORKTREE_HANDLERS['worktree create']({
        flags: projectFlags.set('parent-worktree', 'active'),
        cwd: process.cwd(),
        client: client(),
        json: true
      })
      expect(remoteCall).toHaveBeenLastCalledWith(
        'worktree.create',
        expect.objectContaining({
          repo: 'id:remote-repo',
          parentWorktreeRef: expect.objectContaining({ instanceId: parent.instanceId })
        })
      )
    }
    localCall.mockClear()
    await WORKTREE_HANDLERS['worktree create']({
      flags: flags().set('parent-worktree', 'path:/target/parent'),
      cwd: process.cwd(),
      client: client(),
      json: true
    })
    expect(remoteCall).toHaveBeenLastCalledWith(
      'worktree.create',
      expect.objectContaining({ parentWorktree: 'path:/target/parent' })
    )
    expect(localCall).not.toHaveBeenCalled()
  })
  it('refuses an old server before set and warns locally for inferred flat create', async () => {
    respond([])
    await expect(
      WORKTREE_HANDLERS['worktree set']({
        flags: flags().set('worktree', 'id:remote::/child').set('parent-worktree', 'current'),
        cwd: process.cwd(),
        client: client(),
        json: true
      })
    ).rejects.toThrow('too old to nest')
    expect(remoteCall.mock.calls.map(([method]) => method)).not.toContain('worktree.set')
    remoteCall.mockClear()
    vi.stubEnv('ORCA_WORKTREE_ID', parent.id)
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_caller')
    await WORKTREE_HANDLERS['worktree create']({
      flags: flags(),
      cwd: process.cwd(),
      client: client(),
      json: true
    })
    const create = remoteCall.mock.calls.find(([method]) => method === 'worktree.create')?.[1]
    expect(create.noParent).toBe(true)
    expect(create).not.toHaveProperty('parentWorktreeRef')
    expect(create).not.toHaveProperty('envParentWorkspace')
    expect(create).not.toHaveProperty('cwdParentWorktree')
    expect(create.callerTerminalHandle).toBeUndefined()
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('too old to nest'))
  })
})
