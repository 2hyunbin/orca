// @vitest-environment happy-dom

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraComment, JiraIssue } from '../../../shared/jira-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { AppState } from '../store/types'
import type {
  JiraIssueCommentComposer,
  JiraIssueWorkspaceContent
} from './jira-issue-workspace-content'
import JiraIssueWorkspace from './JiraIssueWorkspace'

type PendingRead<T> = {
  target: RuntimeClientTarget
  key: string
  resolve: (value: T) => void
  reject: (error: Error) => void
}
type ComposerProps = ComponentProps<typeof JiraIssueCommentComposer>
type JiraStoreBoundary = Pick<AppState, 'patchJiraIssue'> & {
  settings: Pick<NonNullable<AppState['settings']>, 'activeRuntimeEnvironmentId'>
}

const boundary = vi.hoisted(
  (): {
    issues: PendingRead<JiraIssue | null>[]
    comments: PendingRead<JiraComment[]>[]
    composer: ComposerProps | null
    settings: JiraStoreBoundary['settings']
  } => ({
    issues: [],
    comments: [],
    composer: null,
    settings: { activeRuntimeEnvironmentId: 'environment-1' }
  })
)

vi.mock('@/store', () => {
  return {
    useAppStore: (select: (state: JiraStoreBoundary) => unknown) =>
      select({
        settings: boundary.settings,
        patchJiraIssue: () => {}
      })
  }
})
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/runtime/runtime-jira-client', () => {
  function request<T>(
    queue: PendingRead<T>[],
    target: RuntimeClientTarget,
    key: string
  ): Promise<T> {
    return new Promise((resolve, reject) => queue.push({ target, key, resolve, reject }))
  }
  return {
    jiraGetIssueForTarget: (target: RuntimeClientTarget, key: string) =>
      request(boundary.issues, target, key),
    jiraIssueCommentsForTarget: (target: RuntimeClientTarget, key: string) =>
      request(boundary.comments, target, key),
    jiraListTransitions: async () => [],
    jiraListPriorities: async () => [],
    jiraListAssignableUsers: async () => [],
    jiraUpdateIssue: async () => ({ ok: true }),
    jiraAddIssueComment: async () => ({ ok: true, id: 'added' })
  }
})
vi.mock('@/components/ui/sheet', () => {
  const Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return {
    // Keep the owner mounted, including its closed content, so stale state is observable.
    Sheet: ({ open, children }: { open: boolean; children: ReactNode }) => (
      <div data-open={open}>{children}</div>
    ),
    SheetContent: Content,
    SheetTitle: Content,
    SheetDescription: Content
  }
})
vi.mock('./jira-issue-workspace-chrome', () => ({
  JiraIssueWorkspaceHeader: ({ issueLoading }: { issueLoading: boolean }) => (
    <div data-testid="issue-loading">{String(issueLoading)}</div>
  ),
  JiraIssueMetadataBar: () => null
}))
vi.mock('./jira-issue-workspace-content', () => ({
  JiraIssueWorkspaceContent: (props: ComponentProps<typeof JiraIssueWorkspaceContent>) => (
    <div data-testid="detail">
      <span data-testid="title">{props.displayed.title}</span>
      <span data-testid="description">{props.displayed.description}</span>
      <span data-testid="image-owner">{JSON.stringify(props.imageTarget)}</span>
      <span data-testid="comments">{props.comments.map((comment) => comment.id).join(',')}</span>
      <span data-testid="comments-loading">{String(props.commentsLoading)}</span>
      <span data-testid="comments-error">{props.commentsError}</span>
      <button type="button" onClick={props.retryComments}>
        Retry
      </button>
    </div>
  ),
  JiraIssueCommentComposer: (props: ComposerProps) => (
    <div
      ref={(node) => {
        boundary.composer = node ? props : null
      }}
    />
  )
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const sourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-1',
  hostId: 'runtime:environment-1'
}
let root: Root | null = null
let container: HTMLDivElement

function issue(key = 'JIR-1', title = key): JiraIssue {
  return {
    id: key,
    key,
    title,
    siteId: 'site-1',
    description: '',
    url: `https://jira.invalid/browse/${key}`,
    project: { id: 'project', key: 'PRJ', name: 'Project' },
    issueType: { id: 'task', name: 'Task' },
    status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'New' },
    labels: [],
    createdAt: '2026-10-02',
    updatedAt: '2026-10-02'
  }
}

function comment(id: string): JiraComment {
  return { id, body: id, createdAt: '2026-10-02' }
}

async function render(
  selected: JiraIssue | null,
  context: TaskSourceContext | null = sourceContext
): Promise<void> {
  if (!root) {
    throw new Error('Missing React root')
  }
  const mountedRoot = root
  await act(async () => {
    mountedRoot.render(
      <JiraIssueWorkspace
        issue={selected}
        sourceContext={context}
        onUse={() => {}}
        onClose={() => {}}
      />
    )
  })
}

function take<T>(queue: PendingRead<T>[]): PendingRead<T> {
  const pending = queue.shift()
  if (!pending) {
    throw new Error('Missing pending Jira read')
  }
  return pending
}

function text(id: string): string | null | undefined {
  return container.querySelector(`[data-testid="${id}"]`)?.textContent
}

async function retryComments(): Promise<void> {
  const button = container.querySelector('button')
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error('Missing Retry button')
  }
  await act(async () => button.click())
}

beforeEach(() => {
  boundary.settings = { activeRuntimeEnvironmentId: 'environment-1' }
  boundary.issues.length = 0
  boundary.comments.length = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  const mountedRoot = root
  if (mountedRoot) {
    await act(async () => mountedRoot.unmount())
  }
  root = null
  await act(async () => {
    for (const pending of [...boundary.issues, ...boundary.comments]) {
      pending.reject(new Error('Test cleanup'))
    }
  })
  boundary.issues.length = 0
  boundary.comments.length = 0
  boundary.composer = null
  document.body.replaceChildren()
})

describe('Jira issue workspace request lifetime', () => {
  it('keeps explicit issue, comment and image ownership when the default host changes', async () => {
    const selected = issue()
    await render(selected)
    expect(boundary.issues.at(-1)?.target).toEqual({
      kind: 'environment',
      environmentId: 'environment-1'
    })
    expect(boundary.comments.at(-1)?.target).toEqual({
      kind: 'environment',
      environmentId: 'environment-1'
    })
    boundary.settings = { activeRuntimeEnvironmentId: 'environment-2' }
    await render(selected)
    expect(boundary.issues.at(-1)?.target).toEqual({
      kind: 'environment',
      environmentId: 'environment-1'
    })
    expect(boundary.comments.at(-1)?.target).toEqual({
      kind: 'environment',
      environmentId: 'environment-1'
    })
    expect(text('image-owner')).toBe(
      JSON.stringify({ kind: 'environment', environmentId: 'environment-1' })
    )
  })

  it('fences late details and comments when the same issue switches owners', async () => {
    const selected = issue()
    await render(selected)
    const oldIssue = take(boundary.issues)
    const oldComments = take(boundary.comments)
    await render(selected, { ...sourceContext, hostId: 'runtime:environment-2' })
    const nextIssue = take(boundary.issues)
    const nextComments = take(boundary.comments)
    expect(nextIssue.target).toEqual({ kind: 'environment', environmentId: 'environment-2' })
    expect(nextComments.target).toEqual(nextIssue.target)
    expect(text('image-owner')).toBe(JSON.stringify(nextIssue.target))
    await act(async () => {
      oldIssue.resolve(issue('JIR-1', 'Old owner'))
      oldComments.resolve([comment('old')])
    })
    expect(text('title')).toBe('JIR-1')
    expect(text('comments')).toBe('')
    await act(async () => {
      nextIssue.resolve(issue('JIR-1', 'New owner'))
      nextComments.resolve([comment('new')])
    })
    expect(text('title')).toBe('New owner')
    expect(text('comments')).toBe('new')
  })

  it('captures the row-less account owner once for details, comments and images', async () => {
    await render(issue(), null)
    const detail = take(boundary.issues)
    const comments = take(boundary.comments)
    expect(detail.target).toEqual({ kind: 'environment', environmentId: 'environment-1' })
    expect(comments.target).toBe(detail.target)
    expect(text('image-owner')).toBe(JSON.stringify(detail.target))
    await act(async () => {
      detail.resolve(null)
      comments.resolve([])
    })
  })

  it('discards late detail and comments after closing the mounted workspace', async () => {
    await render(issue())
    await render(null)
    await act(async () => {
      take(boundary.issues).resolve({ ...issue(), description: 'Screenshot data'.repeat(32_768) })
      take(boundary.comments).resolve([{ ...comment('late'), body: 'Image data'.repeat(32_768) }])
    })
    expect(container.querySelector('[data-open]')?.getAttribute('data-open')).toBe('false')
    expect(container.querySelector('[data-testid="detail"]')).toBeNull()
    expect(boundary.composer).toBeNull()
  })

  it('clears an already hydrated issue and comments when it closes', async () => {
    await render(issue())
    await act(async () => {
      take(boundary.issues).resolve(issue('JIR-1', 'Hydrated'))
      take(boundary.comments).resolve([comment('loaded')])
    })
    expect(text('title')).toBe('Hydrated')
    expect(text('comments')).toBe('loaded')
    expect(text('issue-loading')).toBe('false')
    expect(text('comments-loading')).toBe('false')
    await render(null)
    expect(container.querySelector('[data-testid="detail"]')).toBeNull()
  })

  it('ignores old replies and accepts the reopened issue replies', async () => {
    await render(issue())
    const oldIssue = take(boundary.issues)
    const oldComments = take(boundary.comments)
    await render(null)
    await render(issue('JIR-2'))
    await act(async () => {
      oldIssue.resolve(issue('JIR-1', 'Late old issue'))
      oldComments.resolve([comment('old')])
    })
    expect(text('title')).toBe('JIR-2')
    expect(text('issue-loading')).toBe('true')
    expect(text('comments-loading')).toBe('true')
    await act(async () => {
      take(boundary.issues).resolve(issue('JIR-2', 'New detail'))
      take(boundary.comments).resolve([comment('new')])
    })
    expect(text('title')).toBe('New detail')
    expect(text('comments')).toBe('new')
    expect(text('comments-loading')).toBe('false')
  })

  it('discards a closed comments error together with late issue hydration', async () => {
    await render(issue())
    await render(null)
    await act(async () => {
      take(boundary.comments).reject(new Error('Late failure'))
      take(boundary.issues).resolve(issue('JIR-1', 'Late detail'))
    })
    expect(container.querySelector('[data-testid="detail"]')).toBeNull()
    await render(issue('JIR-2'))
    expect(text('comments-error')).toBe('')
    expect(text('comments-loading')).toBe('true')
  })

  it('keeps open comments errors retryable and clears loading on success', async () => {
    await render(issue())
    await act(async () => {
      take(boundary.issues).resolve(issue())
      take(boundary.comments).reject(new Error('Try again'))
    })
    expect(text('comments-error')).toBe('Try again')
    expect(text('comments-loading')).toBe('false')
    await retryComments()
    expect(text('comments-loading')).toBe('true')
    expect(text('comments-error')).toBe('')
    await act(async () => take(boundary.comments).resolve([comment('retry')]))
    expect(text('comments')).toBe('retry')
    expect(text('comments-loading')).toBe('false')
  })

  it('preserves submitted comments across refresh and deduplicates returned IDs', async () => {
    await render(issue())
    await act(async () => {
      take(boundary.issues).resolve(issue())
      take(boundary.comments).resolve([comment('server')])
    })
    await act(async () => {
      if (!boundary.composer) {
        throw new Error('Missing comment composer')
      }
      boundary.composer.setCommentDraft('Added comment')
    })
    await act(async () => {
      if (!boundary.composer) {
        throw new Error('Missing comment composer')
      }
      boundary.composer.handleSubmitComment()
    })
    expect(text('comments')).toBe('server,added')
    await retryComments()
    await act(async () => take(boundary.comments).resolve([comment('server')]))
    expect(text('comments')).toBe('server,added')
    await retryComments()
    await act(async () => take(boundary.comments).resolve([comment('server'), comment('added')]))
    expect(text('comments')).toBe('server,added')
    expect(boundary.composer?.commentDraft).toBe('')
    expect(boundary.composer?.commentSubmitting).toBe(false)
  })
})
