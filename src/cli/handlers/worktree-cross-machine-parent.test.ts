import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as RuntimeClientModule from '../runtime-client'
import type { RuntimeClient } from '../runtime-client'
import { WORKTREE_CROSS_MACHINE_LINEAGE_CAPABILITY } from '../../shared/worktree-runtime-capabilities'

const { localCall, localConstructor } = vi.hoisted(() => ({
  localCall: vi.fn(),
  localConstructor: vi.fn()
}))
vi.mock('../runtime-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeClientModule>()
  return {
    ...actual,
    RuntimeClient: class {
      constructor(...args: unknown[]) {
        localConstructor(...args)
      }
      call = localCall
    }
  }
})
import { WORKTREE_HANDLERS } from './worktree'

function context(capabilities: string[], explicit: boolean) {
  localCall.mockImplementation(async (method) => ({
    result:
      method === 'worktree.list'
        ? { worktrees: [] }
        : { worktree: { id: 'repo::/parent', instanceId: 'parent-instance', hostId: 'local' } }
  }))
  const call = vi.fn(async (method: string) => ({
    result:
      method === 'status.get'
        ? { capabilities }
        : { worktree: { id: 'repo::/child' }, warnings: [] }
  }))
  // SAFETY: the handler uses only these client fields and call; each response is scoped to that method.
  const client = {
    userDataPath: '/tmp/cml-v3-cli',
    isRemote: true,
    environmentSelector: 'Build server',
    call
  } as unknown as RuntimeClient
  const flags = new Map<string, string | boolean>([
    ['repo', 'id:repo'],
    ['name', 'child']
  ])
  if (explicit) {
    flags.set('parent-worktree', 'id:repo::/parent')
  }
  return { context: { flags, client, cwd: '/unmanaged', json: true }, call }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  localCall.mockReset()
  localConstructor.mockClear()
})

describe('caller-side cross-machine create', () => {
  it('refuses an explicit parent on an old server before create, and lets an inferred parent create flat with a warning', async () => {
    vi.stubEnv('ORCA_WORKSPACE_ID', 'worktree:repo::/parent')
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const explicit = context([], true)
    await expect(WORKTREE_HANDLERS['worktree create'](explicit.context)).rejects.toThrow(
      'Update Orca on Build server'
    )
    expect(explicit.call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
    expect(localConstructor).toHaveBeenCalledWith('/tmp/cml-v3-cli', 60_000, null, null)
    const inferred = context([], false)
    await WORKTREE_HANDLERS['worktree create'](inferred.context)
    expect(inferred.call).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({ parentWorktreeRef: undefined, callerTerminalHandle: undefined })
    )
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Creating without a parent'))
  })

  it('sends the caller parent identity to a capable server', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const capable = context([WORKTREE_CROSS_MACHINE_LINEAGE_CAPABILITY], true)
    await WORKTREE_HANDLERS['worktree create'](capable.context)
    expect(capable.call).toHaveBeenCalledWith(
      'worktree.create',
      expect.objectContaining({
        parentWorktreeRef: {
          worktreeId: 'repo::/parent',
          instanceId: 'parent-instance',
          external: true
        }
      })
    )
  })
})
