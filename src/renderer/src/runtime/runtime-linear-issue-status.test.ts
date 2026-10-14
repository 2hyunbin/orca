import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { linearGetIssue, linearGetIssueStatus } from './runtime-linear-issue-mutations'

const mocks = vi.hoisted(() => ({ call: vi.fn(), local: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({ callRuntimeRpc: mocks.call }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { linear: { getIssue: mocks.local } } })
})
afterEach(() => vi.unstubAllGlobals())

it('requests compact status through the issue owner while the full-detail API stays unchanged', async () => {
  const remote = { kind: 'environment', environmentId: 'owner-runtime' } as const
  await linearGetIssueStatus(remote, 'ENG-1', 'workspace-1')
  await linearGetIssue(remote, 'ENG-1', 'workspace-1')
  expect(mocks.call.mock.calls).toEqual([
    [
      remote,
      'linear.getIssue',
      { id: 'ENG-1', workspaceId: 'workspace-1', statusOnly: true },
      { timeoutMs: 30_000 }
    ],
    [remote, 'linear.getIssue', { id: 'ENG-1', workspaceId: 'workspace-1' }, { timeoutMs: 30_000 }]
  ])
  expect(mocks.local).not.toHaveBeenCalled()
})

it('preserves local full reads and accepts full details returned by an older host', async () => {
  const legacyDetail = { id: 'issue-1', identifier: 'ENG-1', title: 'Legacy detail' }
  mocks.local.mockResolvedValue(legacyDetail)
  await expect(linearGetIssueStatus({ kind: 'local' }, 'ENG-1', null)).resolves.toEqual(
    legacyDetail
  )
  await linearGetIssue({ kind: 'local' }, 'ENG-1', null)
  expect(mocks.local.mock.calls).toEqual([
    [{ id: 'ENG-1', workspaceId: undefined, statusOnly: true }],
    [{ id: 'ENG-1', workspaceId: undefined }]
  ])
  expectTypeOf<
    Awaited<ReturnType<typeof linearGetIssueStatus>>
  >().not.toMatchTypeOf<LinearIssue | null>()
})

it('keeps default-scope routing on full reads and requires an explicit owner for status reads', async () => {
  await linearGetIssue(
    { kind: 'default-scope', settings: { activeRuntimeEnvironmentId: 'focused-runtime' } },
    'ENG-1',
    'workspace-1'
  )
  expect(mocks.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'focused-runtime' },
    'linear.getIssue',
    { id: 'ENG-1', workspaceId: 'workspace-1' },
    { timeoutMs: 30_000 }
  )
  expect(mocks.local).not.toHaveBeenCalled()
  expectTypeOf<Parameters<typeof linearGetIssueStatus>[0]>().toEqualTypeOf<RuntimeClientTarget>()
})
