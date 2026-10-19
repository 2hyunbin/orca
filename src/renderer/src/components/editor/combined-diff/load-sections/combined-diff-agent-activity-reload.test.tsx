// @vitest-environment happy-dom
// Agent activity re-reads a combined Changes view's loaded sections. These pin that a slow read
// never lands over a draft, that activity during a read is not lost, and that a view restored
// after activity it missed while unmounted is revalidated.
import { useState } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { dispatchAgentFileActivityEvent } from '@/hooks/agent-file-activity-event'
import type {
  GitDiffResult,
  GitDiffTextResult
} from '../../../../../../shared/git-diff-compare-types'
import type { DiffSection } from '../../diff-section-types'
import type { CombinedDiffEntrySet } from '../resolve-changes/use-combined-diff-entry-set'
import { useCombinedDiffViewRestore } from '../remember-view/use-combined-diff-view-restore'
import { useCombinedDiffViewPersist } from '../remember-view/use-combined-diff-view-persist'
import {
  combinedDiffScrollAnchorCache,
  combinedDiffScrollTopCache,
  combinedDiffViewStateCache
} from '../remember-view/combined-diff-view-memory'
import { useCombinedDiffSectionLoadRegistry } from './combined-diff-section-load-registry'
import { useCombinedDiffSectionRetry } from './use-combined-diff-section-retry'
import { useCombinedDiffSectionRevalidation } from './use-combined-diff-section-revalidation'

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('./fetch-combined-diff-section', () => ({ fetchCombinedDiffSection: mocks.fetch }))
import { useCombinedDiffSectionLoader } from './use-combined-diff-section-loader'

const file: OpenFile = {
  id: 'diff',
  filePath: '/repo',
  relativePath: 'file.ts',
  worktreeId: 'wt',
  isDirty: false,
  language: 'typescript',
  mode: 'diff',
  diffSource: 'combined-uncommitted'
}
const entries = [
  { path: 'file.ts', status: 'modified' as const, area: 'unstaged' as const, added: 1 }
]
const entrySet: CombinedDiffEntrySet = {
  entries,
  uncommittedEntries: entries,
  allEntries: entries,
  branchCompare: null,
  commitCompare: null,
  commitEntries: [],
  entrySignature: 'one',
  hasUncommittedEntriesSnapshot: false,
  isAllMode: false,
  isBranchMode: false,
  isCommitMode: false,
  renderableBranchEntries: [],
  shouldAutoReloadFromGitStatus: false,
  treeMode: 'uncommitted'
}

function useViewer() {
  const [sections, setSections] = useState<DiffSection[]>([])
  const [sectionHeights, setSectionHeights] = useState<Record<number, number>>({})
  const [, setGeneration] = useState(0)
  const [sideBySide, setSideBySide] = useState(false)
  const registry = useCombinedDiffSectionLoadRegistry(sections)
  const restore = useCombinedDiffViewRestore({
    entrySet,
    gitStatusEntries: [],
    registry,
    setGeneration,
    setSectionHeights,
    setSections,
    setSideBySide,
    viewStateKey: 'view',
    worktreeId: file.worktreeId
  })
  useCombinedDiffSectionLoader({
    entrySet,
    file,
    registry,
    sectionCount: sections.length,
    setSectionHeights,
    setSections
  })
  const retry = useCombinedDiffSectionRetry({
    invalidateViewStateCache: restore.invalidateViewStateCache,
    registry,
    setSectionHeights,
    setSections
  })
  const signature = useCombinedDiffSectionRevalidation({
    file,
    gitStatusEntries: [],
    registry,
    requestSectionReload: retry.requestSectionReload,
    sectionIndexByKeyRef: { current: new Map() },
    sectionEntries: entrySet.entries,
    shouldAutoReloadFromGitStatus: false,
    treeMode: 'uncommitted'
  })
  useCombinedDiffViewPersist({
    combinedGitStatusSignature: signature,
    entryCount: entries.length,
    entrySignature: entrySet.entrySignature,
    loadedIndicesRef: registry.loadedIndicesRef,
    scrollContainerRef: { current: null },
    sectionHeights,
    sections,
    sideBySide,
    viewStateKey: 'view',
    worktreeId: file.worktreeId
  })
  return { sections, setSections, registry }
}

function deferredResult() {
  let resolve!: (result: GitDiffResult) => void
  const promise = new Promise<GitDiffResult>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function textResult(modifiedContent: string): GitDiffTextResult {
  return {
    kind: 'text',
    originalContent: 'base',
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

const loads: ReturnType<typeof deferredResult>[] = []

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function settle(index: number, modifiedContent: string): Promise<void> {
  await act(async () => {
    loads[index]!.resolve(textResult(modifiedContent))
    await Promise.resolve()
  })
  await flush(300)
}

async function startLoadedViewer() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.fetch.mockImplementation(() => {
    const load = deferredResult()
    loads.push(load)
    return load.promise
  })
  const hook = renderHook(useViewer)
  await flush()
  await settle(0, 'v1')
  expect(hook.result.current.sections[0]).toMatchObject({ modifiedContent: 'v1', loading: false })
  // The row is on screen, so a reload refetches it instead of deferring until scrolled into view.
  hook.result.current.registry.renderedIndicesRef.current.add(0)
  return hook
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  mocks.fetch.mockReset()
  loads.length = 0
  combinedDiffViewStateCache.clear()
  combinedDiffScrollAnchorCache.clear()
  combinedDiffScrollTopCache.clear()
})

describe('combined diff agent-activity reloads', () => {
  it('never lands a slow read over text the user typed during it', async () => {
    const hook = await startLoadedViewer()
    act(() => dispatchAgentFileActivityEvent('wt'))
    await flush(300)
    expect(loads).toHaveLength(2)
    const generation = hook.result.current.sections[0]!.contentGeneration
    act(() => {
      hook.result.current.setSections((prev) =>
        prev.map((section) => ({ ...section, dirty: true, modifiedContent: 'typed' }))
      )
    })
    await settle(1, 'agent wrote this')
    expect(hook.result.current.sections[0]).toMatchObject({ dirty: true, modifiedContent: 'typed' })
    expect(hook.result.current.sections[0]!.contentGeneration).toBe(generation)
  })

  it('re-reads once more when activity lands while a read is in flight', async () => {
    const hook = await startLoadedViewer()
    act(() => dispatchAgentFileActivityEvent('wt'))
    await flush(300)
    expect(loads).toHaveLength(2)
    act(() => dispatchAgentFileActivityEvent('wt'))
    act(() => dispatchAgentFileActivityEvent('wt'))
    await settle(1, 'v2')
    expect(hook.result.current.sections[0]).toMatchObject({ modifiedContent: 'v2' })
    expect(loads).toHaveLength(3)
    await settle(2, 'v3')
    expect(hook.result.current.sections[0]).toMatchObject({ modifiedContent: 'v3' })
    expect(loads).toHaveLength(3)
  })

  it('revalidates a remembered view after activity it missed while unmounted', async () => {
    const hook = await startLoadedViewer()
    hook.unmount()
    dispatchAgentFileActivityEvent('wt')
    const remounted = renderHook(useViewer)
    remounted.result.current.registry.renderedIndicesRef.current.add(0)
    await flush(300)
    expect(remounted.result.current.sections[0]).toMatchObject({ modifiedContent: 'v1' })
    expect(loads).toHaveLength(2)
    await settle(1, 'v2')
    expect(remounted.result.current.sections[0]).toMatchObject({ modifiedContent: 'v2' })
  })

  it('restores a remembered view without a re-read when nothing happened meanwhile', async () => {
    const hook = await startLoadedViewer()
    hook.unmount()
    renderHook(useViewer)
    await flush(300)
    expect(loads).toHaveLength(1)
  })
})
