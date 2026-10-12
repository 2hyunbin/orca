import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeWithListManagedWorktrees } from './orca-runtime-list-managed-worktrees'
import { OrcaRuntimeService } from './orca-runtime'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { LaunchHostRepo } from './worktree-launch-host-repo'

const scanWorkspacePortsMock = vi.hoisted(() => vi.fn())

vi.mock('../ports/local-workspace-port-scanner', () => ({
  scanWorkspacePorts: scanWorkspacePortsMock
}))

const proto = OrcaRuntimeWithListManagedWorktrees.prototype

function runtimeResolvingTo(executionHostId: ExecutionHostId) {
  const host = {
    resolveRuntimeFileTarget: vi.fn(async () => ({ worktree: {}, executionHostId })),
    getWorkspacePortProbes: vi.fn(async () => []),
    getWorkspacePortHostDeps: proto['getWorkspacePortHostDeps']
  }
  const runtimeHost = new OrcaRuntimeService()
  Object.defineProperties(runtimeHost, {
    resolveRuntimeFileTarget: { value: host.resolveRuntimeFileTarget },
    getWorkspacePortProbes: { value: host.getWorkspacePortProbes }
  })
  return {
    host,
    scan: (selector: string) => proto.scanWorkspacePortsOnHost.call(runtimeHost, selector),
    kill: (args: Parameters<typeof proto.killWorkspacePortOnHost>[0]) =>
      proto.killWorkspacePortOnHost.call(runtimeHost, args)
  }
}

describe('host-scoped workspace port scans on the server', () => {
  afterEach(() => {
    scanWorkspacePortsMock.mockReset()
    vi.restoreAllMocks()
  })

  it("reports a folder workspace's SSH host unavailable instead of scanning this server", async () => {
    const runtime = runtimeResolvingTo('ssh:box')

    const result = await runtime.scan('folder:fw-1')

    expect(runtime.host.resolveRuntimeFileTarget).toHaveBeenCalledWith('folder:fw-1')
    expect(scanWorkspacePortsMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({ executionHostId: 'ssh:box', ports: [] })
    expect(result.unavailableReason).toMatch(/Reconnect/)
  })

  it('refuses Stop when the workspace now resolves to a different host than the row', async () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
    const runtime = runtimeResolvingTo('local')

    const result = await runtime.kill({
      worktree: 'id:repo::/srv/app',
      executionHostId: 'ssh:box',
      pid: 4242,
      port: 3020
    })

    expect(result).toMatchObject({ ok: false })
    expect(kill).not.toHaveBeenCalled()
  })

  it('authorizes Stop only with workspaces this host runs itself', async () => {
    const repos: (LaunchHostRepo & { path: string })[] = [
      { id: 'local-repo', path: '/srv/app' },
      // An SSH repo may carry only its execution host, with no legacy connectionId.
      { id: 'ssh-repo', path: '/srv/private', executionHostId: 'ssh:box' },
      { id: 'legacy-ssh-repo', path: '/srv/legacy', connectionId: 'box' },
      { id: 'runtime-repo', path: '/srv/env', executionHostId: 'runtime:env-2' }
    ]
    const worktree = (repoId: string, path: string) => ({
      id: `${repoId}::${path}`,
      repoId,
      displayName: '',
      git: { path }
    })
    const host = {
      requireStore: () => ({ getRepos: () => repos }),
      listResolvedWorktrees: async () => [
        worktree('local-repo', '/srv/app'),
        worktree('ssh-repo', '/srv/private'),
        worktree('legacy-ssh-repo', '/srv/legacy'),
        worktree('runtime-repo', '/srv/env')
      ]
    }

    const runtime = new OrcaRuntimeService()
    Object.defineProperties(runtime, {
      requireStore: { value: host.requireStore },
      listResolvedWorktrees: { value: host.listResolvedWorktrees }
    })
    const probes = await proto['getWorkspacePortProbes'].call(runtime)

    expect(probes.map((probe) => probe.path)).toEqual(['/srv/app'])
  })
})
