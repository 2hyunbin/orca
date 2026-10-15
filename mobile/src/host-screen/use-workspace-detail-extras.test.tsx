import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useWorkspaceDetailExtras, type WorkspaceDetailExtras } from './use-workspace-detail-extras'

type Reply = { result: unknown } | { error: string }

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function fakeClient(replies: Record<string, Reply>) {
  const sendRequest = vi.fn(async (method: string): Promise<RpcResponse> => {
    const reply = replies[method]
    if (!reply || 'error' in reply) {
      return { id: '1', ok: false, error: { code: 'forbidden', message: reply?.error ?? 'no' } }
    }
    return { id: '1', ok: true, result: reply.result }
  })
  return { sendRequest }
}

function row(overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: 'repo::/src/app',
    repoId: 'repo',
    repo: 'orca',
    branch: 'refs/heads/feat/x',
    displayName: 'x',
    path: '/src/app',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

async function readExtras(
  target: Worktree,
  client: ReturnType<typeof fakeClient>
): Promise<WorkspaceDetailExtras> {
  let latest: WorkspaceDetailExtras = {}
  function Probe() {
    latest = useWorkspaceDetailExtras(target, client)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Probe))
  })
  return latest
}

const methods = (client: ReturnType<typeof fakeClient>) =>
  client.sendRequest.mock.calls.map(([method]) => method)

const portScan = {
  result: {
    executionHostId: 'local',
    platform: 'darwin',
    scannedAt: 1,
    ports: [
      {
        id: 'a',
        kind: 'workspace',
        owner: { worktreeId: 'repo::/src/app' },
        bindHost: '0.0.0.0',
        connectHost: 'localhost',
        port: 5173,
        protocol: 'http'
      }
    ]
  }
}

describe('the long-press details reads', () => {
  it('asks a plain workspace only for its ports, scoped to that workspace', async () => {
    const client = fakeClient({ 'workspacePorts.scanHost': portScan })

    const extras = await readExtras(row(), client)

    expect(methods(client)).toEqual(['workspacePorts.scanHost'])
    expect(client.sendRequest.mock.calls[0]?.[1]).toEqual({ worktree: 'id:repo::/src/app' })
    expect(extras.ports).toEqual([
      { id: 'a', port: 5173, address: 'localhost:5173', processName: undefined }
    ])
  })

  it("reads the branch review for a row with a PR, and who made an automation's workspace", async () => {
    const client = fakeClient({
      'hostedReview.forBranch': {
        result: {
          provider: 'github',
          number: 12,
          title: 'Search keyboard',
          state: 'open',
          url: 'https://github.com/o/r/pull/12',
          status: 'success',
          updatedAt: '',
          mergeable: 'MERGEABLE'
        }
      },
      'worktree.show': {
        result: { worktree: { automationProvenance: { automationNameSnapshot: 'Nightly' } } }
      },
      'workspacePorts.scanHost': portScan
    })

    const extras = await readExtras(
      row({ linkedPR: { number: 12, state: 'open' }, automationCreated: true }),
      client
    )

    expect(methods(client).sort()).toEqual([
      'hostedReview.forBranch',
      'workspacePorts.scanHost',
      'worktree.show'
    ])
    const reviewParams = client.sendRequest.mock.calls.find(
      ([method]) => method === 'hostedReview.forBranch'
    )?.[1]
    expect(reviewParams).toMatchObject({ branch: 'feat/x', linkedGitHubPR: 12 })
    expect(extras.review).toMatchObject({ title: 'Search keyboard' })
    expect(extras.origin?.automation).toEqual({ name: 'Nightly', runTitle: undefined })
  })

  it('leaves each section at what the row says when an older desktop refuses its read', async () => {
    const client = fakeClient({})

    const extras = await readExtras(
      row({ linkedPR: { number: 12, state: 'open' }, cliCreated: true }),
      client
    )

    expect(extras).toEqual({ review: null, origin: null, ports: null })
  })

  it('does not ask a folder workspace for a branch review', async () => {
    const client = fakeClient({ 'workspacePorts.scanHost': portScan })

    await readExtras(
      row({ workspaceKind: 'folder-workspace', worktreeId: 'folder:f1', linkedIssue: 3 }),
      client
    )

    expect(methods(client)).toEqual(['workspacePorts.scanHost'])
  })

  it('reads nothing without a host to ask (a server not reachable yet)', async () => {
    let latest: WorkspaceDetailExtras | null = null
    function Probe() {
      latest = useWorkspaceDetailExtras(row(), null)
      return null
    }
    await act(async () => {
      renderer = create(createElement(Probe))
    })
    expect(latest).toEqual({})
  })
})
