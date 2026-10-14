// @vitest-environment happy-dom

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraMutationResult, JiraTransition } from '../../../shared/jira-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getDefaultSettings } from '../../../shared/constants'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { JiraPatchOptions } from '../store/slices/jira-slice-contract'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { getJiraReadScope } from '@/store/slices/jira-read-coordination'
import type { RowLessSource } from '@/lib/default-creation-host'
import type * as I18n from '@/i18n/i18n'
import { TooltipProvider } from '@/components/ui/tooltip'
import JiraIssueWorkspace from './JiraIssueWorkspace'

const runtimeMocks = vi.hoisted(() => ({
  jiraAddIssueComment: vi.fn(),
  jiraGetIssue: vi.fn(),
  jiraIssueComments: vi.fn(),
  jiraListAssignableUsers: vi.fn(),
  jiraListPriorities: vi.fn(),
  jiraListTransitions: vi.fn(),
  jiraUpdateIssue: vi.fn()
}))

const store = vi.hoisted(() => ({
  patchJiraIssue:
    vi.fn<(key: string, patch: Partial<JiraIssue>, options?: JiraPatchOptions) => void>()
}))
let currentSettings: GlobalSettings | null = null

vi.mock('@/runtime/runtime-jira-client', () => runtimeMocks)
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: object) => unknown) =>
    selector({
      settings: currentSettings,
      patchJiraIssue: (key: string, patch: Partial<JiraIssue>, options?: JiraPatchOptions) =>
        store.patchJiraIssue(key, patch, options)
    })
}))
vi.mock('@/i18n/i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof I18n>()),
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

function jiraIssue(title: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10001',
    key: 'ENG-1',
    siteId: 'site-1',
    title,
    url: 'https://example.atlassian.net/browse/ENG-1',
    project: { id: '1', key: 'ENG', name: 'Engineering' },
    issueType: { id: '1', name: 'Task' },
    status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

const otherIssue = jiraIssue('Other issue', { id: '10002', key: 'ENG-2' })

let selectIssue = (_issue: JiraIssue | null): void => undefined
let selectSource = (_source: TaskSourceContext): void => undefined
const initialSource: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'local'
}
const initialSourceContextKey = getJiraReadScope(null, initialSource).contextKey

// Why: the task page reads the open issue back out of the Jira store, so an
// optimistic patch hands the workspace a new object for the same issue.
function StoreBackedWorkspace({ initial }: { initial: JiraIssue }): React.JSX.Element {
  const [issue, setIssue] = useState<JiraIssue | null>(initial)
  const [source, setSource] = useState(initialSource)
  store.patchJiraIssue.mockImplementation((key, patch, options) =>
    setIssue((current) =>
      current?.key === key &&
      (options?.siteId == null || current.siteId === options.siteId) &&
      (!options?.sourceContext ||
        getTaskSourceCacheScope(options.sourceContext) === getTaskSourceCacheScope(source))
        ? { ...current, ...patch }
        : current
    )
  )
  selectIssue = setIssue
  selectSource = setSource
  return (
    <TooltipProvider>
      <JiraIssueWorkspace issue={issue} sourceContext={source} onUse={vi.fn()} onClose={vi.fn()} />
    </TooltipProvider>
  )
}

const pendingRequests = new Set<(error: Error) => void>()

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => undefined
  let reject = (_error: Error): void => undefined
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  pendingRequests.add(reject)
  void promise.then(
    () => pendingRequests.delete(reject),
    () => pendingRequests.delete(reject)
  )
  return { promise, resolve }
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0))
  })
}

function saveTitle(from: string, to: string): void {
  const input = screen.getByDisplayValue(from)
  fireEvent.change(input, { target: { value: to } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

let serverTitle = 'Old title'

beforeEach(() => {
  currentSettings = null
  serverTitle = 'Old title'
  store.patchJiraIssue.mockReset()
  for (const mock of Object.values(runtimeMocks)) {
    mock.mockReset()
  }
  runtimeMocks.jiraGetIssue.mockImplementation(async () => jiraIssue(serverTitle))
  runtimeMocks.jiraIssueComments.mockResolvedValue([])
  runtimeMocks.jiraListTransitions.mockResolvedValue([])
  runtimeMocks.jiraListPriorities.mockResolvedValue([])
  runtimeMocks.jiraListAssignableUsers.mockResolvedValue([])
})

afterEach(async () => {
  cleanup()
  await act(async () => {
    for (const reject of pendingRequests) {
      reject(new Error('Test cleanup'))
    }
    await new Promise((done) => setTimeout(done, 0))
  })
})

describe('JiraIssueWorkspace optimistic edits', () => {
  it.each([true, false])(
    'captures the default host when a save settles after navigation (%s)',
    async (ok) => {
      const oldSave = deferred<JiraMutationResult>()
      runtimeMocks.jiraUpdateIssue.mockReturnValue(oldSave.promise)
      const contextKey = getProviderRuntimeContextKey(currentSettings)
      const view = render(
        <TooltipProvider>
          <JiraIssueWorkspace issue={jiraIssue('Old title')} onUse={vi.fn()} onClose={vi.fn()} />
        </TooltipProvider>
      )
      await flushPromises()
      saveTitle('Old title', 'Local edit')
      await flushPromises()
      currentSettings = { ...getDefaultSettings(''), activeRuntimeEnvironmentId: 'remote-1' }
      runtimeMocks.jiraGetIssue.mockImplementation(async (source: RowLessSource) =>
        jiraIssue(
          source.kind === 'default-scope' && source.settings?.activeRuntimeEnvironmentId
            ? 'Remote title'
            : 'Local edit'
        )
      )
      view.rerender(
        <TooltipProvider>
          <JiraIssueWorkspace issue={jiraIssue('Remote title')} onUse={vi.fn()} onClose={vi.fn()} />
        </TooltipProvider>
      )
      await flushPromises()
      await act(async () =>
        oldSave.resolve(ok ? { ok: true } : { ok: false, error: 'Local edit rejected' })
      )
      await flushPromises()

      expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
        'ENG-1',
        expect.objectContaining({ title: ok ? 'Local edit' : 'Old title' }),
        expect.objectContaining({ contextKey, siteId: 'site-1' })
      )
      expect(screen.getByDisplayValue('Remote title')).toBeDefined()
    }
  )

  it('keeps loaded and submitted comments while a title save patches the shared cache', async () => {
    runtimeMocks.jiraUpdateIssue.mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraIssueComments.mockResolvedValue([
      { id: 'server', body: 'Existing comment', createdAt: '2026-09-01' }
    ])
    runtimeMocks.jiraAddIssueComment.mockResolvedValue({ ok: true, id: 'added' })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    fireEvent.change(screen.getByPlaceholderText('Add a Jira comment...'), {
      target: { value: 'New comment' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))
    await flushPromises()
    saveTitle('Old title', 'New title')
    await flushPromises()
    expect(screen.getByText('Existing comment')).toBeDefined()
    expect(screen.getByText('New comment')).toBeDefined()
    expect(runtimeMocks.jiraIssueComments).toHaveBeenCalledTimes(1)
  })

  it('reloads when the same issue moves to another source account on the same host', async () => {
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    await act(async () => selectSource({ ...initialSource, accountLabel: 'other-account' }))
    await flushPromises()
    expect(runtimeMocks.jiraGetIssue).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.jiraGetIssue).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountLabel: 'other-account' }),
      'ENG-1',
      'site-1'
    )
  })

  it('keeps the new title on screen while the save is in flight', async () => {
    const update = deferred<{ ok: true }>()
    runtimeMocks.jiraUpdateIssue.mockReturnValue(update.promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()

    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledTimes(1)
    expect(screen.getByDisplayValue('New title')).toBeDefined()
    expect(runtimeMocks.jiraGetIssue).toHaveBeenCalledTimes(1)

    serverTitle = 'New title'
    await act(async () => update.resolve({ ok: true }))
    await flushPromises()

    expect(runtimeMocks.jiraGetIssue).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('New title')).toBeDefined()
  })

  it('restores the previous title when the save fails', async () => {
    runtimeMocks.jiraUpdateIssue.mockResolvedValue({ ok: false, error: 'Nope' })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()

    await waitFor(() => expect(screen.getByDisplayValue('Old title')).toBeDefined())
  })

  it.each(['priority', 'assignee'] as const)(
    'keeps a cleared %s cleared when an older detail load arrives',
    async (field) => {
      const initialLoad = deferred<JiraIssue>()
      const initial = jiraIssue('Old title', {
        priority: { id: '1', name: 'High' },
        assignee: { accountId: 'jane', displayName: 'Jane' }
      })
      runtimeMocks.jiraGetIssue.mockReturnValue(initialLoad.promise)
      runtimeMocks.jiraUpdateIssue.mockReturnValue(deferred<{ ok: true }>().promise)
      render(<StoreBackedWorkspace initial={initial} />)
      await flushPromises()
      fireEvent.click(screen.getByRole('button', { name: field === 'priority' ? 'High' : 'Jane' }))
      fireEvent.click(
        await screen.findByRole('button', {
          name: field === 'priority' ? 'No priority' : 'Unassigned'
        })
      )
      await act(async () => initialLoad.resolve(initial))
      await flushPromises()
      expect(
        screen.queryByRole('button', { name: field === 'priority' ? 'High' : 'Jane' })
      ).toBeNull()
      expect(runtimeMocks.jiraGetIssue).toHaveBeenCalledTimes(1)
      expect(runtimeMocks.jiraIssueComments).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps fields hydrated during a failed title save', async () => {
    const initialLoad = deferred<JiraIssue>()
    const update = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraGetIssue.mockReturnValue(initialLoad.promise)
    runtimeMocks.jiraUpdateIssue.mockReturnValue(update.promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'New title')
    await act(async () => initialLoad.resolve(jiraIssue('Old title', { labels: ['backend'] })))
    await flushPromises()
    await act(async () => update.resolve({ ok: false, error: 'Rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it('allows editing a newly opened issue while an earlier save is still pending', async () => {
    const oldSave = deferred<{ ok: true }>()
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockResolvedValue({ ok: true })
    runtimeMocks.jiraGetIssue.mockImplementation(async (_settings: unknown, key: string) =>
      key === 'ENG-2' ? otherIssue : jiraIssue(serverTitle)
    )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'New title')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    saveTitle('Other issue', 'Other updated')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledTimes(2)
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    expect(screen.getByText('ENG-2')).toBeDefined()
  })

  it('offers the new status transitions after a status change', async () => {
    // Why: Jira only allows transitions out of the current status, so the menu
    // must be reloaded once the issue has moved.
    const inProgress = {
      id: '3',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    }
    const done = { id: '4', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
    runtimeMocks.jiraListTransitions
      .mockResolvedValueOnce([{ id: '11', name: 'Start progress', to: inProgress }])
      .mockResolvedValue([{ id: '21', name: 'Finish', to: done }])
    runtimeMocks.jiraUpdateIssue.mockResolvedValue({ ok: true })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    fireEvent.click(screen.getByRole('button', { name: 'To Do' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start progress' }))
    await flushPromises()

    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledWith(
      initialSource,
      'ENG-1',
      { transitionId: '11' },
      'site-1'
    )
    // The menu stays open after picking a transition, so it must now list the new ones.
    expect(screen.queryByRole('button', { name: 'Start progress' })).toBeNull()
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeDefined()
  })

  it('still hydrates fields the user did not edit when the initial load lands late', async () => {
    const initialLoad = deferred<JiraIssue>()
    runtimeMocks.jiraGetIssue.mockImplementationOnce(() => initialLoad.promise)
    runtimeMocks.jiraUpdateIssue.mockReturnValue(deferred<{ ok: true }>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()
    await act(async () => initialLoad.resolve(jiraIssue('Old title', { labels: ['backend'] })))
    await flushPromises()

    expect(screen.getByDisplayValue('New title')).toBeDefined()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it.each([
    ['succeeds', { ok: true }],
    ['fails', { ok: false, error: 'Nope' }]
  ])('stays on the newly opened issue when a save for the previous one %s', async (_, outcome) => {
    // Why: the task page keeps one workspace instance across selections, so a
    // save that finishes after switching must not write the old issue back.
    const update = deferred<typeof outcome>()
    runtimeMocks.jiraUpdateIssue.mockReturnValue(update.promise)
    runtimeMocks.jiraGetIssue.mockImplementation(async (_settings: unknown, key: string) =>
      key === 'ENG-2' ? otherIssue : jiraIssue(serverTitle)
    )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    expect(screen.getByText('ENG-2')).toBeDefined()
    serverTitle = 'New title'
    await act(async () => update.resolve(outcome))
    await flushPromises()

    expect(screen.getByText('ENG-2')).toBeDefined()
    expect(screen.queryByText('ENG-1')).toBeNull()
    expect(screen.getByDisplayValue('Other issue')).toBeDefined()
  })

  it('does not let a slow initial load overwrite a title saved meanwhile', async () => {
    const initialLoad = deferred<JiraIssue>()
    runtimeMocks.jiraGetIssue
      .mockImplementationOnce(() => initialLoad.promise)
      .mockImplementation(async () => jiraIssue(serverTitle))
    runtimeMocks.jiraUpdateIssue.mockImplementation(async () => {
      serverTitle = 'New title'
      return { ok: true }
    })
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()

    saveTitle('Old title', 'New title')
    await flushPromises()
    await act(async () => initialLoad.resolve(jiraIssue('Old title')))
    await flushPromises()

    expect(screen.getByDisplayValue('New title')).toBeDefined()
  })

  it('keeps a newer reopened-issue edit when an earlier save fails', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraGetIssue.mockImplementation(async (_settings: unknown, key: string) =>
      key === 'ENG-2' ? otherIssue : jiraIssue('Old title')
    )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      expect.objectContaining({ title: 'Latest edit' }),
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
  })

  it('keeps a newer reopened-issue edit when an earlier refresh returns late', async () => {
    const oldSave = deferred<{ ok: true }>()
    const oldRefresh = deferred<JiraIssue>()
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    runtimeMocks.jiraGetIssue
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockImplementation(async (_settings: unknown, key: string) =>
        key === 'ENG-2' ? otherIssue : jiraIssue('Old title')
      )
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    await act(async () => oldRefresh.resolve(jiraIssue('First edit')))
    await flushPromises()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      expect.objectContaining({ title: 'Latest edit' }),
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
  })

  it('restores confirmed values when both reopened title saves fail', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssue
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValue(deferred<JiraIssue>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledTimes(1)
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
    await act(async () => newerSave.resolve({ ok: false, error: 'Second save rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      { title: 'Old title' },
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
  })

  it('rolls back a failed title while preserving a newer edit to another field', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    const high = { id: '1', name: 'High' }
    const low = { id: '2', name: 'Low' }
    runtimeMocks.jiraListPriorities.mockResolvedValue([high, low])
    runtimeMocks.jiraGetIssue
      .mockResolvedValueOnce(jiraIssue('Old title', { priority: high }))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValue(deferred<JiraIssue>().promise)
    render(<StoreBackedWorkspace initial={jiraIssue('Old title', { priority: high })} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit', { priority: high })))
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: 'High' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Low' }))
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'Title rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(
      screen
        .getAllByRole('button', { name: 'Low' })
        .some((button) => button.hasAttribute('disabled'))
    ).toBe(true)
    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenLastCalledWith(
      initialSource,
      'ENG-1',
      { priorityId: '2' },
      'site-1'
    )
  })

  it('preserves mutation order when the workspace unmounts and remounts', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValue(deferred<{ ok: true }>().promise)
    const mounted = render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    mounted.unmount()
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('First edit', 'Latest edit')
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledTimes(1)
    await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
    await flushPromises()
    expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledTimes(2)
    expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
    expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
      'ENG-1',
      { title: 'Latest edit' },
      { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
    )
  })

  it.each(['account', 'host', 'site'] as const)(
    'keeps saves independent when the same issue key moves to another %s',
    async (kind) => {
      const oldSave = deferred<{ ok: false; error: string }>()
      runtimeMocks.jiraUpdateIssue
        .mockReturnValueOnce(oldSave.promise)
        .mockReturnValue(deferred<{ ok: true }>().promise)
      render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
      await flushPromises()
      saveTitle('Old title', 'First edit')
      await act(async () => {
        if (kind === 'site') {
          selectIssue(jiraIssue('Old title', { siteId: 'site-2' }))
        } else {
          selectSource({
            ...initialSource,
            ...(kind === 'account'
              ? { accountLabel: 'other-account' }
              : { hostId: 'runtime:other-host' })
          })
        }
      })
      await flushPromises()
      saveTitle('Old title', 'Latest edit')
      await flushPromises()
      expect(runtimeMocks.jiraUpdateIssue).toHaveBeenCalledTimes(2)
      await act(async () => oldSave.resolve({ ok: false, error: 'First save rejected' }))
      await flushPromises()
      expect(screen.getByDisplayValue('Latest edit')).toBeDefined()
      expect(store.patchJiraIssue).toHaveBeenLastCalledWith(
        'ENG-1',
        { title: 'Old title' },
        { sourceContext: initialSource, siteId: 'site-1', contextKey: initialSourceContextKey }
      )
    }
  )

  it('preserves a replayed save across reopened hydration and synchronizes the title draft', async () => {
    const oldSave = deferred<{ ok: true }>()
    const reopenedLoad = deferred<JiraIssue>()
    runtimeMocks.jiraUpdateIssue.mockReturnValue(oldSave.promise)
    runtimeMocks.jiraGetIssue
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockReturnValueOnce(reopenedLoad.promise)
      .mockResolvedValue(jiraIssue('First edit'))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    expect(screen.getByDisplayValue('First edit')).toBeDefined()
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => reopenedLoad.resolve(jiraIssue('Old title')))
    await flushPromises()
    expect(screen.getByDisplayValue('First edit')).toBeDefined()
    expect(screen.queryByDisplayValue('Old title')).toBeNull()
  })

  it.each([
    ['succeeds', { ok: true }],
    ['fails', { ok: false, error: 'Title rejected' }]
  ] as const)(
    'preserves an unsaved title draft when an older reopened save %s',
    async (_, outcome) => {
      const oldSave = deferred<typeof outcome>()
      runtimeMocks.jiraUpdateIssue.mockReturnValue(oldSave.promise)
      runtimeMocks.jiraGetIssue
        .mockResolvedValueOnce(jiraIssue('Old title'))
        .mockResolvedValueOnce(otherIssue)
        .mockResolvedValueOnce(jiraIssue('Old title'))
        .mockResolvedValue(jiraIssue('First edit'))
      render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
      await flushPromises()
      saveTitle('Old title', 'First edit')
      await act(async () => selectIssue(otherIssue))
      await flushPromises()
      await act(async () => selectIssue(jiraIssue('Old title')))
      await flushPromises()
      fireEvent.change(screen.getByDisplayValue('First edit'), {
        target: { value: 'Unsubmitted draft' }
      })
      await act(async () => oldSave.resolve(outcome))
      await flushPromises()
      expect(screen.getByDisplayValue('Unsubmitted draft')).toBeDefined()
      expect(
        screen.getAllByRole('heading', { name: outcome.ok ? 'First edit' : 'Old title' }).length
      ).toBeGreaterThan(0)
    }
  )

  it('uses newly hydrated values as the rollback baseline for a different field', async () => {
    const oldSave = deferred<{ ok: false; error: string }>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssue
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValue(jiraIssue('Old title', { labels: ['backend'] }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    const labels = screen.getByDisplayValue('backend')
    fireEvent.change(labels, { target: { value: 'new' } })
    const save = labels.parentElement?.querySelector('button')
    if (!(save instanceof HTMLButtonElement)) {
      throw new Error('Missing labels save button')
    }
    fireEvent.click(save)
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: false, error: 'Title rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('new')).toBeDefined()
    await act(async () => newerSave.resolve({ ok: false, error: 'Labels rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('Old title')).toBeDefined()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it('reloads transitions on a reopened issue when its earlier status save completes', async () => {
    const oldSave = deferred<{ ok: true }>()
    const reopenedTransitions = deferred<JiraTransition[]>()
    const inProgress = {
      id: '3',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    }
    const start = { id: '11', name: 'Start progress', to: inProgress }
    const done = { id: '4', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
    runtimeMocks.jiraListTransitions
      .mockResolvedValueOnce([start])
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(reopenedTransitions.promise)
      .mockResolvedValue([{ id: '21', name: 'Finish', to: done }])
    runtimeMocks.jiraUpdateIssue.mockReturnValue(oldSave.promise)
    runtimeMocks.jiraGetIssue
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValue(jiraIssue('Old title', { status: inProgress }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: 'To Do' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start progress' }))
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    expect(runtimeMocks.jiraListTransitions).toHaveBeenCalledTimes(4)
    await act(async () => reopenedTransitions.resolve([start]))
    await flushPromises()
    if (!screen.queryByRole('button', { name: 'Finish' })) {
      fireEvent.click(screen.getByRole('button', { name: 'In Progress' }))
    }
    expect(await screen.findByRole('button', { name: 'Finish' })).toBeDefined()
    expect(screen.queryByRole('button', { name: 'Start progress' })).toBeNull()
  })

  it('keeps a newer hydrated rollback baseline when an older refresh returns stale fields', async () => {
    const oldSave = deferred<{ ok: true }>()
    const oldRefresh = deferred<JiraIssue>()
    const newerSave = deferred<{ ok: false; error: string }>()
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssue
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockReturnValueOnce(oldRefresh.promise)
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValue(jiraIssue('First edit', { labels: ['backend'] }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    saveTitle('Old title', 'First edit')
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('First edit')))
    await flushPromises()
    const labels = screen.getByDisplayValue('backend')
    fireEvent.change(labels, { target: { value: 'new' } })
    const save = labels.parentElement?.querySelector('button')
    if (!(save instanceof HTMLButtonElement)) {
      throw new Error('Missing labels save button')
    }
    fireEvent.click(save)
    await flushPromises()
    await act(async () => oldRefresh.resolve(jiraIssue('First edit')))
    await flushPromises()
    await act(async () => newerSave.resolve({ ok: false, error: 'Labels rejected' }))
    await flushPromises()
    expect(screen.getByDisplayValue('backend')).toBeDefined()
  })

  it('reloads transitions when the last queued status save fails after an earlier success', async () => {
    const oldSave = deferred<{ ok: true }>()
    const newerSave = deferred<{ ok: false; error: string }>()
    const inProgress = {
      id: '3',
      name: 'In Progress',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    }
    const done = { id: '4', name: 'Done', categoryKey: 'done', categoryName: 'Done' }
    const start = { id: '11', name: 'Start progress', to: inProgress }
    const finish = { id: '21', name: 'Finish', to: done }
    runtimeMocks.jiraListTransitions
      .mockResolvedValueOnce([start])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([start, finish])
      .mockResolvedValue([finish])
    runtimeMocks.jiraUpdateIssue
      .mockReturnValueOnce(oldSave.promise)
      .mockReturnValueOnce(newerSave.promise)
    runtimeMocks.jiraGetIssue
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValueOnce(otherIssue)
      .mockResolvedValueOnce(jiraIssue('Old title'))
      .mockResolvedValue(jiraIssue('Old title', { status: inProgress }))
    render(<StoreBackedWorkspace initial={jiraIssue('Old title')} />)
    await flushPromises()
    fireEvent.click(screen.getByRole('button', { name: 'To Do' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Start progress' }))
    await act(async () => selectIssue(otherIssue))
    await flushPromises()
    await act(async () => selectIssue(jiraIssue('Old title')))
    await flushPromises()
    if (!screen.queryByRole('button', { name: 'Finish' })) {
      fireEvent.click(screen.getByRole('button', { name: 'In Progress' }))
    }
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }))
    await act(async () => oldSave.resolve({ ok: true }))
    await flushPromises()
    await act(async () => newerSave.resolve({ ok: false, error: 'Status rejected' }))
    await flushPromises()
    expect(runtimeMocks.jiraListTransitions).toHaveBeenCalledTimes(4)
    expect(screen.queryByRole('button', { name: 'Start progress' })).toBeNull()
  })
})
