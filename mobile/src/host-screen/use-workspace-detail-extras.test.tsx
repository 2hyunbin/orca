import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import type { Worktree } from '../worktree/workspace-list-types'
import { useWorkspaceDetailExtras, type WorkspaceDetailExtras } from './use-workspace-detail-extras'

type Reply = { result: unknown } | { error: string }
type Client = { sendRequest: (method: string, params?: unknown) => Promise<RpcResponse> }

let renderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

function fakeClient(replies: Record<string, Reply>) {
  const sendRequest = vi.fn(async (method: string, _params?: unknown): Promise<RpcResponse> => {
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

function renderProbe(client: Client | null, target: Worktree | null) {
  const seen: { latest: WorkspaceDetailExtras } = { latest: {} }
  function Probe({ value }: { value: Worktree | null }) {
    seen.latest = useWorkspaceDetailExtras(value, client)
    return null
  }
  return {
    seen,
    mount: () =>
      act(async () => {
        renderer = create(createElement(Probe, { value: target }))
      }),
    show: (value: Worktree | null) =>
      act(async () => {
        renderer!.update(createElement(Probe, { value }))
      })
  }
}

const methods = (client: ReturnType<typeof fakeClient>) =>
  client.sendRequest.mock.calls.map(([method]) => method)

const automationShow = {
  result: { worktree: { automationProvenance: { automationNameSnapshot: 'Nightly' } } }
}

describe('the long-press details reads', () => {
  it('asks nothing of a workspace whose row shows no review and no automation', async () => {
    const client = fakeClient({})
    // The CLI origin is all on the row.
    const probe = renderProbe(client, row({ comment: 'notes', linkedIssue: 3, cliCreated: true }))
    await probe.mount()

    expect(methods(client)).toEqual([])
    expect(probe.seen.latest).toEqual({})
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
      'worktree.show': automationShow
    })
    const probe = renderProbe(
      client,
      row({ linkedPR: { number: 12, state: 'open' }, automationCreated: true })
    )
    await probe.mount()

    expect(methods(client).sort()).toEqual(['hostedReview.forBranch', 'worktree.show'])
    const params = (method: string) =>
      client.sendRequest.mock.calls.find(([called]) => called === method)?.[1]
    // A one-off read must not take the host's active-branch slot from the open session.
    expect(params('hostedReview.forBranch')).toMatchObject({
      branch: 'feat/x',
      linkedGitHubPR: null,
      active: false
    })
    expect(params('worktree.show')).toEqual({ worktree: 'id:repo::/src/app' })
    expect(probe.seen.latest.review).toMatchObject({ title: 'Search keyboard' })
    expect(probe.seen.latest.origin).toEqual({ automationName: 'Nightly' })
  })

  it('leaves each section at what the row says when an older desktop refuses its read', async () => {
    const probe = renderProbe(
      fakeClient({}),
      row({ linkedPR: { number: 12, state: 'open' }, automationCreated: true })
    )
    await probe.mount()

    expect(probe.seen.latest).toEqual({ review: null, origin: null })
  })

  it('does not ask a folder workspace for a branch review', async () => {
    const client = fakeClient({})
    await renderProbe(
      client,
      row({
        workspaceKind: 'folder-workspace',
        worktreeId: 'folder:f1',
        linkedPR: { number: 2, state: 'open' }
      })
    ).mount()

    expect(methods(client)).toEqual([])
  })

  it('reads nothing without a host to ask (a server not reachable yet)', async () => {
    const probe = renderProbe(null, row({ automationCreated: true }))
    await probe.mount()

    expect(probe.seen.latest).toEqual({})
  })

  it('drops a late reply for the row the sheet has moved off', async () => {
    let answerA: (value: RpcResponse) => void = () => {}
    const client = {
      sendRequest: vi.fn((_method: string, params?: unknown): Promise<RpcResponse> =>
        JSON.stringify(params).includes('wt-a')
          ? new Promise((resolve) => {
              answerA = resolve
            })
          : Promise.resolve({ id: '1', ok: true, result: { worktree: {} } })
      )
    }
    const probe = renderProbe(client, row({ worktreeId: 'wt-a', automationCreated: true }))
    await probe.mount()
    await probe.show(row({ worktreeId: 'wt-b', automationCreated: true }))
    await act(async () => {
      answerA({ id: '1', ok: true, result: automationShow.result })
    })

    expect(probe.seen.latest).toEqual({ origin: null })
  })

  it('forgets the last open when the sheet closes, so a reopen reads afresh', async () => {
    const client = fakeClient({ 'worktree.show': automationShow })
    const target = row({ automationCreated: true })
    const probe = renderProbe(client, target)
    await probe.mount()
    await probe.show(null)
    // The reopened read has not answered yet.
    client.sendRequest.mockImplementation(() => new Promise<RpcResponse>(() => {}))
    await probe.show(target)

    expect(probe.seen.latest).toEqual({})
    expect(methods(client)).toEqual(['worktree.show', 'worktree.show'])
  })
})
