// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type PRFilterDropdowns from '@/components/github/PRFilterDropdowns'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import TaskPage from '../TaskPage'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { TaskPageGitHubFilters } from './Filters'
import type { TaskPageRepoSourceState } from '../task-page-cache-selectors'
import { getTaskPresetViewerLogin } from './task-page-preset-highlight'

const fixture = vi.hoisted((): { sources: TaskPageRepoSourceState[] } => ({ sources: [] }))

vi.mock('../Surface', () => ({
  TaskPageSurface: ({ model }: { model: TaskPageComposerActionsModel }) => (
    <TooltipProvider>
      <button onClick={() => model.handleSelectGithubTaskKind('prs')}>PRs</button>
      <TaskPageGitHubFilters model={{ ...model, perRepoSourceState: fixture.sources }} />
    </TooltipProvider>
  )
}))
vi.mock('@/components/github/PRFilterDropdowns', () => ({
  default: ({ onChange }: ComponentProps<typeof PRFilterDropdowns>) => (
    <>
      <button onClick={() => onChange({ author: 'OCTOCAT' })}>Own author</button>
      <button onClick={() => onChange({ author: 'hubot' })}>Other author</button>
      <button onClick={() => onChange({ assignee: 'octocat' })}>Own assignee</button>
      <button onClick={() => onChange({ reviewer: { kind: 'requested', login: 'octocat' } })}>
        Own reviewer
      </button>
      <button onClick={() => onChange({ state: 'closed' })}>Closed</button>
      <button onClick={() => onChange({ state: 'open' })}>Reopen</button>
    </>
  )
}))

const initialStore = useAppStore.getState()
const initialApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api')
const viewer = vi.fn<typeof window.api.gh.viewer>()

beforeEach(() => {
  fixture.sources = []
  viewer.mockReset().mockResolvedValue({ login: 'octocat', email: null })
  useAppStore.setState(
    { ...initialStore, settings: null, persistedUIReady: false, repos: [], taskPageData: {} },
    true
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { gh: { viewer }, ui: { set: vi.fn().mockResolvedValue(undefined) } }
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  if (initialApiDescriptor) {
    Object.defineProperty(window, 'api', initialApiDescriptor)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name, exact: true }))
}
function expectActive(name: string, active = true) {
  const button = screen.getByRole('button', { name, exact: true })
  if (active) {
    expect(button).toHaveClass('bg-foreground/90')
  } else {
    expect(button).not.toHaveClass('bg-foreground/90')
  }
}
async function renderFilters() {
  // Let the existing viewer lookup finish before using its login in a filter.
  await act(async () => {
    render(<TaskPage />)
  })
}

describe('GitHub Tasks preset highlight follows the applied query', () => {
  it('keeps Mine for an equivalent author and restores it after reopening', async () => {
    await renderFilters()
    click('PRs')
    click('Mine')
    expectActive('Mine')
    click('Own author')
    expectActive('Mine')
    click('Closed')
    expectActive('Mine', false)
    expectActive('Open', false)
    click('Reopen')
    expectActive('Mine')
    click('Other author')
    expectActive('Mine', false)
    expectActive('Open', false)
  })

  it('recognizes personal issue and review queries without clicking their presets', async () => {
    await renderFilters()
    click('Own assignee')
    expectActive('Assigned to me')
    click('PRs')
    click('Own reviewer')
    expectActive('Needs review')
    click('Closed')
    expectActive('Needs review', false)
  })

  it('derives Open from a submitted query and clears it for merged results', async () => {
    await renderFilters()
    click('PRs')
    const search = screen.getByPlaceholderText('Search GitHub PRs...')
    fireEvent.change(search, { target: { value: 'is:pr state:open' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expectActive('Open')
    fireEvent.change(search, { target: { value: 'is:pr is:merged author:@me' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expectActive('Open', false)
    expectActive('Mine', false)
  })

  it('recognizes @me without a viewer and does not guess an unresolved login', async () => {
    viewer.mockResolvedValue(null)
    await renderFilters()
    click('PRs')
    click('Mine')
    expectActive('Mine')
    click('Own author')
    expectActive('Mine', false)
    expectActive('Open', false)
  })

  it.each(['runtime:server', 'enterprise'] as const)(
    'does not use the default viewer for a different source (%s)',
    async (source) => {
      fixture.sources = [
        {
          repoId: 'repo',
          repoPath: '/repo',
          sourceKey: 'repo',
          error: null,
          hostId: source === 'enterprise' ? 'local' : source,
          sources: {
            issues: null,
            prs: {
              owner: 'org',
              repo: 'repo',
              host: source === 'enterprise' ? 'github.example.com' : 'github.com'
            },
            originCandidate: null,
            upstreamCandidate: null
          }
        }
      ]
      await renderFilters()
      click('PRs')
      click('Mine')
      expectActive('Mine')
      click('Own author')
      expectActive('Mine', false)
      expectActive('Open', false)
      expect(viewer).toHaveBeenCalledTimes(1)
    }
  )

  it('checks each source at most once at ordinary and large selection sizes', () => {
    for (const size of [100, 1000]) {
      let reads = 0
      const sources: TaskPageRepoSourceState[] = Array.from({ length: size }, (_, index) => ({
        repoId: String(index),
        repoPath: '/repo',
        sourceKey: String(index),
        sources: null,
        error: null,
        get hostId() {
          reads += 1
          return 'local'
        }
      }))
      expect(getTaskPresetViewerLogin('prs', sources, 'octocat')).toBe('octocat')
      expect(reads).toBe(size)
    }
  })
})
