import { describe, expect, it } from 'vitest'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { CacheEntry } from '@/store/github/cache-model'
import { findTaskPageDialogWorkItem } from './task-page-cache-selectors'

function workItem(overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: 'issue:1',
    type: 'issue',
    number: 1,
    title: 'A task',
    state: 'open',
    url: 'https://github.com/owner/project/issues/1',
    labels: [],
    updatedAt: '2026-10-13T00:00:00Z',
    author: null,
    repoId: 'repo',
    ...overrides
  }
}

function entry(data: readonly GitHubWorkItem[] | null): CacheEntry<readonly GitHubWorkItem[]> {
  return { data, fetchedAt: 1 }
}

describe('Tasks drawer work-item lookup', () => {
  it('scans an unchanged cache once across unrelated store snapshots and equal lookup keys', () => {
    let itemReads = 0
    const target = workItem()
    const items = Array.from({ length: 100 }, (_, index) =>
      Object.defineProperty(workItem(), 'id', {
        get() {
          itemReads += 1
          return index === 99 ? target.id : `issue:${index + 2}`
        }
      })
    )
    const workItemsCache = { source: entry(items) }
    const first = { workItemsCache, runtimePaneTitlesByTabId: {} }
    const lookup = { id: target.id, repoId: target.repoId, url: target.url }
    const found = findTaskPageDialogWorkItem(first.workItemsCache, lookup)
    expect(found).toBe(items[99])
    expect(itemReads).toBe(100)

    for (let publication = 0; publication < 20; publication += 1) {
      const next = { ...first, runtimePaneTitlesByTabId: { tab: { 0: `frame ${publication}` } } }
      expect(findTaskPageDialogWorkItem(next.workItemsCache, { ...lookup })).toBe(found)
    }
    expect(itemReads).toBe(100)
  })

  it('caches misses while checking fresh fetches, optimistic patches and evictions immediately', () => {
    let reads = 0
    const target = workItem()
    const lookup = { id: target.id, repoId: target.repoId, url: target.url }
    const missing = {
      source: entry([
        Object.defineProperty(workItem(), 'id', {
          get() {
            reads += 1
            return 'other'
          }
        })
      ])
    }
    expect(findTaskPageDialogWorkItem(missing, lookup)).toBeNull()
    expect(findTaskPageDialogWorkItem(missing, { ...lookup })).toBeNull()
    expect(reads).toBe(1)

    const fetched = { ...missing, source: entry([target]) }
    expect(findTaskPageDialogWorkItem(fetched, lookup)).toBe(target)
    const edited = { ...target, title: 'Edited task', state: 'closed' as const }
    const patched = { ...fetched, source: { ...fetched.source, data: [edited] } }
    expect(findTaskPageDialogWorkItem(patched, lookup)).toBe(edited)
    expect(findTaskPageDialogWorkItem({}, lookup)).toBeNull()
  })

  it('keeps exact id, repo and URL matching, first-list precedence and host cache isolation', () => {
    const target = workItem()
    const wrongRepo = { ...target, repoId: 'other' }
    const upstream = { ...target, url: 'https://github.com/upstream/project/issues/1' }
    const first = { ...target, title: 'First source' }
    const second = { ...target, title: 'Second source' }
    const lookup = { id: target.id, repoId: target.repoId, url: target.url }
    const cache = {
      wrongRepo: entry([wrongRepo]),
      upstream: entry([upstream]),
      first: entry([first, second]),
      second: entry([second])
    }
    expect(findTaskPageDialogWorkItem(cache, lookup)).toBe(first)
    expect(findTaskPageDialogWorkItem(cache, { ...lookup, repoId: 'other' })).toBe(wrongRepo)
    expect(findTaskPageDialogWorkItem(cache, { ...lookup, url: upstream.url })).toBe(upstream)
    expect(findTaskPageDialogWorkItem(cache, { ...lookup, id: 'missing' })).toBeNull()
    expect(findTaskPageDialogWorkItem(cache, lookup)).toBe(first)

    const remote = { ...target, title: 'Remote source' }
    expect(findTaskPageDialogWorkItem({ source: entry([remote]) }, lookup)).toBe(remote)
    expect(findTaskPageDialogWorkItem(cache, lookup)).toBe(first)
  })

  it('does not enumerate a closed drawer and preserves own-key source ordering', () => {
    const trap = new Proxy<Record<string, CacheEntry<readonly GitHubWorkItem[]>>>(
      {},
      {
        ownKeys() {
          throw new Error('closed drawer searched the cache')
        }
      }
    )
    expect(findTaskPageDialogWorkItem(trap, null)).toBeNull()
    const target = workItem()
    const lookup = { id: target.id, repoId: target.repoId, url: target.url }
    const numeric = { ...target, title: 'Numeric key sorts first' }
    const cache = Object.fromEntries([
      ['__proto__', entry([target])],
      ['constructor', entry(null)],
      ['2', entry([numeric])]
    ])
    expect(findTaskPageDialogWorkItem(cache, lookup)).toBe(numeric)
    expect(findTaskPageDialogWorkItem(cache, { ...lookup })).toBe(numeric)
  })
})
