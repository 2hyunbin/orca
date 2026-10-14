import { describe, expect, it, vi } from 'vitest'
import { makeRepo, makeWorktree } from './worktree-list-lineage-card-test-fixtures'
import { addHostSectionRows, type HostSectionOption } from './host-section-rows'
import { buildRows } from './worktree-list/grouping/build-rows'
import type { Row } from './worktree-list/grouping/row-types'

const hostOptions: HostSectionOption[] = [
  { id: 'local', kind: 'local', label: 'Local', detail: '', health: 'local' },
  { id: 'ssh:builder', kind: 'ssh', label: 'Builder', detail: '', health: 'available' }
]
function lane(count: number, prefix = 'workspace'): Row[] {
  const localRepo = makeRepo()
  const remoteRepo = { ...localRepo, id: 'remote-repo', executionHostId: 'ssh:builder' as const }
  const worktrees = Array.from({ length: count }, (_unused, index) => ({
    ...makeWorktree({
      id: `${prefix}-${index}`,
      instanceId: `${prefix}-${index}`,
      displayName: `${prefix}-${index}`,
      branch: 'topic',
      sortOrder: index
    }),
    repoId: index % 2 === 0 ? localRepo.id : remoteRepo.id,
    hostId: index % 2 === 0 ? ('local' as const) : ('ssh:builder' as const)
  }))
  return buildRows(
    'none',
    worktrees,
    new Map([
      [localRepo.id, localRepo],
      [remoteRepo.id, remoteRepo]
    ]),
    null,
    new Set()
  )
}
function section(rows: readonly Row[]) {
  return addHostSectionRows({
    rows,
    hostOptions,
    workspaceHostScope: 'all',
    visibleWorkspaceHostIds: ['local', 'ssh:builder'],
    defaultHostId: 'local',
    preferProjectGrouping: true
  })
}
function globalHeader(rows: readonly Row[]) {
  const header = rows.find((row) => row.type === 'header' && row.key === 'all')
  if (header?.type !== 'header' || !header.hostWorktreeCounts) {
    throw new Error('Expected a shared All header with host counts')
  }
  return header.hostWorktreeCounts
}

describe('host section header scan budget', () => {
  it('localizes a shared header once per host instead of once per workspace', () => {
    const rows = lane(100)
    const counts = globalHeader(rows)
    const reads = vi.spyOn(counts, 'get')
    const result = section(rows)

    expect(reads).toHaveBeenCalledTimes(2)
    expect(result.filter((row) => row.type === 'host-header')).toMatchObject([
      { hostId: 'local', count: 50 },
      { hostId: 'ssh:builder', count: 50 }
    ])
    expect(result.filter((row) => row.type === 'header')).toMatchObject([
      { hostId: 'local', count: 50 },
      { hostId: 'ssh:builder', count: 50 }
    ])
    expect(result.filter((row) => row.type === 'item')).toHaveLength(100)
    reads.mockRestore()
  })

  it('checks a later header again while retaining identical-header deduplication', () => {
    const rows = lane(20)
    const counts = globalHeader(rows)
    const reads = vi.spyOn(counts, 'get')
    const result = section([...rows, ...rows])

    expect(reads).toHaveBeenCalledTimes(4)
    expect(result.filter((row) => row.type === 'header')).toHaveLength(2)
    expect(result.filter((row) => row.type === 'item')).toHaveLength(40)
    expect(result.filter((row) => row.type === 'host-header')).toMatchObject([
      { count: 10 },
      { count: 10 }
    ])
    reads.mockRestore()
  })

  it('skips repeated empty localizations without publishing the header to that host', () => {
    const rows = lane(20)
    const counts = globalHeader(rows)
    counts.delete('local')
    const reads = vi.spyOn(counts, 'get')
    const result = section(rows)

    expect(reads).toHaveBeenCalledTimes(2)
    expect(result.filter((row) => row.type === 'header')).toMatchObject([
      { hostId: 'ssh:builder', count: 10 }
    ])
    expect(result.filter((row) => row.type === 'item')).toHaveLength(20)
    reads.mockRestore()
  })

  it('keeps a later header when its workspace membership changes', () => {
    const first = lane(20, 'first')
    const second = lane(20, 'second')
    const result = section([...first, ...second])

    expect(result.filter((row) => row.type === 'header')).toHaveLength(4)
    expect(result.filter((row) => row.type === 'host-header')).toMatchObject([
      { count: 20 },
      { count: 20 }
    ])
  })
})
