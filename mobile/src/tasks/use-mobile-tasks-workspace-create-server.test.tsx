import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeSession } from '../transport/mobile-endpoint-supervisor-test-fakes'
import type { RpcResponse } from '../transport/types'
import { routeTaskRepoCalls, taskRepoServer } from './task-repo-host-routing'
import { workspaceSshTargetKey, type WorkspaceSshEntry } from './workspace-ssh-gate'
import type { ActionableTaskItem, RepoSummary } from './mobile-tasks-legacy-foundation'
import type { WorkspaceSparseActionsModel } from './use-mobile-tasks-workspace-sparse-actions'

vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  return {
    useCallback: react.useCallback,
    useEffect: react.useEffect,
    useMemo: react.useMemo,
    ...(await import('./workspace-agent-selection')),
    ...(await import('./setup-hook-trust')),
    ...(await import('./workspace-create-params')),
    ...(await import('./hosted-review-start-point')),
    ...(await import('./workspace-create-timeout'))
  }
})

const { useMobileTasksWorkspaceSshState } = await import('./use-mobile-tasks-workspace-ssh-state')
const { useMobileTasksWorkspaceCreateActions } =
  await import('./use-mobile-tasks-workspace-create-actions')

type Sent = { method: string; executionHost?: string }
const sentBy = new WeakMap<FakeSession, Sent[]>()

/** Records where each call ran, then answers it with `answer`. */
function recording(
  client: FakeSession,
  answer: (method: string, executionHost: string | undefined) => Promise<RpcResponse>
): FakeSession {
  const sent: Sent[] = []
  sentBy.set(client, sent)
  client.sendRequest.mockImplementation(
    async (method: string, _params?: unknown, options?: { executionHost?: string }) => {
      sent.push({ method, executionHost: options?.executionHost })
      return answer(method, options?.executionHost)
    }
  )
  return client
}

function reply(result: unknown): RpcResponse {
  return { id: 'reply', ok: true, result, _meta: { runtimeId: 'runtime' } }
}

const SERVER_REPO: RepoSummary = {
  id: 'vm-repo',
  displayName: 'api',
  path: '/srv/api',
  executionHostId: 'runtime:vm'
}
const DESKTOP_REPO: RepoSummary = { id: 'mac-repo', displayName: 'app', path: '/mac/app' }

function issueOn(repo: RepoSummary): ActionableTaskItem {
  return {
    key: `github:${repo.id}:issue:7`,
    provider: 'github',
    title: 'Fix the thing',
    subtitle: '',
    status: 'Open',
    updatedAt: '2026-10-11T00:00:00Z',
    source: {
      id: 'issue:7',
      type: 'issue',
      number: 7,
      title: 'Fix the thing',
      state: 'open',
      url: 'https://github.com/o/r/issues/7',
      labels: [],
      updatedAt: '2026-10-11T00:00:00Z',
      author: null,
      repoId: repo.id,
      repoName: repo.displayName
    }
  }
}

function desktop(): FakeSession {
  return recording(new FakeSession('connected'), async (method) => {
    if (method === 'worktree.create') {
      return reply({ worktree: { id: 'wt-1', displayName: 'fix-the-thing' } })
    }
    if (method === 'ssh.getState') {
      return reply({ state: CONNECTED_SSH })
    }
    return reply(method.startsWith('preflight.detect') ? [] : {})
  })
}

function ranOn(client: FakeSession, method: string): string[] {
  return (sentBy.get(client) ?? [])
    .filter((sent) => sent.method === method)
    .map((sent) => sent.executionHost ?? 'desktop')
}

const mounted: ReactTestRenderer[] = []
afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount())
  }
})

const CONNECTED_SSH = { targetId: 'ssh-1', status: 'connected', error: null, reconnectAttempt: 0 }
// The desktop and the server each hold an SSH target named `ssh-1`.
const SERVER_SSH_REPO: RepoSummary = {
  id: 'vm-ssh-repo',
  displayName: 'remote',
  path: '/r',
  connectionId: 'ssh-1',
  executionHostId: 'runtime:vm'
}

async function createFrom(repo: RepoSummary, workspaceSshState: WorkspaceSshEntry | null = null) {
  const client = desktop()
  const pushed: string[] = []
  const item = issueOn(repo)
  const noop = () => {}
  const model = {
    client: routeTaskRepoCalls(client, () => [DESKTOP_REPO, SERVER_REPO, SERVER_SSH_REPO]),
    hostId: 'mac',
    router: { push: (href: string) => pushed.push(href) },
    runtimeTaskSettings: {},
    tasksSupported: true,
    taskStateHydrated: true,
    trustedOrcaHooks: {},
    workspaceAgent: 'blank',
    workspaceAgentOverridden: true,
    workspaceCreateDraft: { item },
    workspaceCreateRequiresSshConnection: false,
    workspaceCreateSshStatus: 'connected',
    workspaceCreateTargetConnectionId: repo.connectionId ?? null,
    workspaceCreateTargetRepo: repo,
    workspaceCreateTargetSshKey: workspaceSshTargetKey(
      taskRepoServer(repo),
      repo.connectionId ?? null
    ),
    workspaceDetectedAgentIds: null,
    workspaceLastAutoName: '',
    workspaceSshState,
    getWorkspaceTargetRepo: () => repo,
    setActionItem: noop,
    setCreatingKey: noop,
    setError: noop,
    setOrcaYamlTrustPrompt: noop,
    setRuntimeTaskSettings: noop,
    setSetupPrompt: noop,
    setWorkspaceAgent: noop,
    setWorkspaceAgentOverridden: noop,
    setWorkspaceCreateDraft: noop,
    setWorkspaceDetectedAgentIds: noop,
    setWorkspaceSshConnecting: noop,
    setWorkspaceSshState: noop
  }
  const seen: { create?: ReturnType<typeof useMobileTasksWorkspaceCreateActions> } = {}
  function Harness(): null {
    seen.create = useMobileTasksWorkspaceCreateActions(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the model carries every member these two stages read.
      useMobileTasksWorkspaceSshState({ ...model } as unknown as WorkspaceSparseActionsModel)
    )
    return null
  }
  await act(async () => {
    mounted.push(create(createElement(Harness)))
  })
  await act(async () => {
    await seen.create!.createWorkspace(item, undefined, undefined, 'blank')
  })
  return { client, pushed }
}

describe('creating a workspace from a task on a server repo', () => {
  it('creates it on that server, detects agents there, and opens it there', async () => {
    const { client, pushed } = await createFrom(SERVER_REPO)
    expect(ranOn(client, 'worktree.create')).toEqual(['runtime:vm'])
    expect(ranOn(client, 'preflight.detectAgents')).toEqual(['runtime:vm'])
    expect(pushed).toHaveLength(1)
    expect(new URL(pushed[0]!, 'orca://x').searchParams.get('executionHost')).toBe('runtime:vm')
  })

  it("keeps a desktop repo's workspace on the desktop", async () => {
    const { client, pushed } = await createFrom(DESKTOP_REPO)
    expect(ranOn(client, 'worktree.create')).toEqual(['desktop'])
    expect(ranOn(client, 'preflight.detectAgents')).toEqual(['desktop'])
    expect(new URL(pushed[0]!, 'orca://x').searchParams.get('executionHost')).toBeNull()
  })

  it("checks a server SSH repo's connection and agents on that server", async () => {
    const { client } = await createFrom(SERVER_SSH_REPO)
    expect(ranOn(client, 'ssh.getState')).toEqual(['runtime:vm'])
    expect(ranOn(client, 'preflight.detectRemoteAgents')).toEqual(['runtime:vm'])
    expect(ranOn(client, 'worktree.create')).toEqual(['runtime:vm'])
  })

  it("doesn't take the desktop's connected target for the server's target of the same id", async () => {
    const desktopConnected = {
      target: workspaceSshTargetKey(undefined, 'ssh-1'),
      record: { targetId: 'ssh-1', status: 'connected' as const, error: null, reconnectAttempt: 0 }
    }
    const { client } = await createFrom(SERVER_SSH_REPO, desktopConnected)
    // The desktop's record doesn't count, so the server is asked.
    expect(ranOn(client, 'ssh.getState')).toEqual(['runtime:vm'])
  })
})
