import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { WorkspaceExecutionHostContext } from '../navigation/workspace-execution-host'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'

const route = vi.hoisted(() => {
  const opened: unknown[] = []
  return { opened, router: { push: (href: unknown) => opened.push(['push', href]) } }
})

vi.mock('../navigation/route-handoff', () => ({ useRouteHandoff: () => route.router }))
vi.mock('../files/mobile-file-mutation-ownership', () => ({
  captureMobileFileMutationOwnership: async () => ({})
}))

import { useMobileSessionContentCreateActions } from './use-mobile-session-content-create-actions'

const META = { runtimeId: 'runtime-1' }

async function createMarkdownNote(openReply: RpcResponse) {
  route.opened.length = 0
  const methods: string[] = []
  const toasts: string[] = []
  const fetchedTabs: number[] = []
  const sendRequest = async (method: string): Promise<RpcResponse> => {
    methods.push(method)
    return method === 'files.open' ? openReply : { id: 'call', ok: true, result: {}, _meta: META }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the note create reaches `sendRequest` and nothing else on the client.
  const client = { sendRequest } as RpcClient
  const held: { create: (() => Promise<void>) | null } = { create: null }
  function Probe(): null {
    held.create = useMobileSessionContentCreateActions(
      mountFixture<Parameters<typeof useMobileSessionContentCreateActions>[0]>({
        hostId: 'host-1',
        worktreeId: 'wt',
        worktreeName: 'api',
        client,
        creatingMarkdown: false,
        setCreatingMarkdown: () => {},
        setCreateError: () => {},
        handleCreateBrowserRef: { current: () => Promise.resolve(false) },
        scheduleDelayedAction: (callback: () => void) => callback(),
        showToast: (message: string) => toasts.push(message),
        fetchSessionTabs: async () => {
          fetchedTabs.push(1)
        }
      })
    ).handleCreateMarkdownNote
    return null
  }
  await act(async () => {
    create(
      createElement(
        WorkspaceExecutionHostContext.Provider,
        { value: normalizeExecutionHostId('runtime:vm') ?? undefined },
        createElement(Probe)
      )
    )
  })
  await act(async () => {
    await held.create?.()
  })
  return { methods, toasts, fetchedTabs }
}

describe('creating a markdown note', () => {
  it("previews the new note when the workspace's server has no editor tabs", async () => {
    const result = await createMarkdownNote({
      id: 'call',
      ok: false,
      error: { code: 'runtime_error', message: 'renderer_unavailable' },
      _meta: META
    })
    expect(result.methods).toEqual(['files.createFile', 'files.open'])
    expect(route.opened).toEqual([
      [
        'push',
        {
          pathname: '/h/[hostId]/files/preview/[worktreeId]',
          params: {
            hostId: 'host-1',
            worktreeId: 'wt',
            source: 'worktree',
            relativePath: 'untitled.md',
            name: 'untitled.md',
            worktreeName: 'api',
            executionHost: 'runtime:vm'
          }
        }
      ]
    ])
    expect(result.toasts).toEqual([])
  })

  it('opens the new note as a desktop tab when the host has one', async () => {
    const result = await createMarkdownNote({ id: 'call', ok: true, result: {}, _meta: META })
    expect(result.methods).toEqual(['files.createFile', 'files.open'])
    expect(route.opened).toEqual([])
    expect(result.fetchedTabs).toEqual([1])
    expect(result.toasts).toEqual([])
  })
})
