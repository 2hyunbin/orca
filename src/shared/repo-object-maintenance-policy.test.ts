import { describe, expect, it } from 'vitest'
import {
  LOOSE_OBJECT_THRESHOLD,
  OBJECT_BACKLOG_PACK_COUNT,
  OBJECT_PACK_COUNT_THRESHOLD,
  objectMaintenanceArgs,
  parseGitVersion,
  planObjectMaintenance,
  type GitVersion,
  type ObjectStoreProbe
} from './repo-object-maintenance-policy'

const CLEAN: ObjectStoreProbe = { packCount: 3, looseObjects: 0, looseBytes: 0 }
const FRAGMENTED: ObjectStoreProbe = { ...CLEAN, packCount: OBJECT_PACK_COUNT_THRESHOLD }

function plan(
  version: GitVersion,
  probe: ObjectStoreProbe,
  options: { partialClone?: boolean; disabled?: string[] } = {}
): ReturnType<typeof planObjectMaintenance> {
  return planObjectMaintenance({
    version,
    probe,
    partialClone: options.partialClone ?? false,
    disabledTasks: new Set(options.disabled ?? [])
  })
}

const v = (text: string): GitVersion => {
  const parsed = parseGitVersion(`git version ${text}`)
  if (!parsed) {
    throw new Error(text)
  }
  return parsed
}

describe('object maintenance plan', () => {
  it('stays idle below both of Git’s own auto thresholds', () => {
    expect(plan(v('2.55.0'), CLEAN)).toEqual({ kind: 'skip', reason: 'below_threshold' })
    expect(plan(v('2.55.0'), { ...CLEAN, looseObjects: LOOSE_OBJECT_THRESHOLD - 1 }).kind).toBe(
      'skip'
    )
  })

  it('never schedules worktree-prune or reflog-expire on any supported Git', () => {
    for (const version of ['2.30.0', '2.45.2', '2.53.0', '2.55.0']) {
      for (const partialClone of [false, true]) {
        const result = plan(v(version), FRAGMENTED, { partialClone })
        expect(result.kind).toBe('run')
        if (result.kind === 'run') {
          const args = objectMaintenanceArgs(result.tasks).join(' ')
          expect(args).not.toMatch(/worktree-prune|reflog-expire|task=gc/)
          expect(args).toMatch(/^-c maintenance\.autoDetach=false maintenance run .* --quiet$/)
        }
      }
    }
  })

  it('picks geometric repacking on 2.53+, and skips repacking promisor packs on older Git', () => {
    const tasks = (version: string, partialClone: boolean): readonly string[] | undefined => {
      const result = plan(v(version), FRAGMENTED, { partialClone })
      return result.kind === 'run' ? result.tasks : undefined
    }
    expect(tasks('2.53.0', true)).toEqual(['loose-objects', 'geometric-repack', 'commit-graph'])
    expect(tasks('2.52.9', true)).toEqual(['loose-objects', 'commit-graph'])
    expect(tasks('2.52.9', false)).toEqual(['loose-objects', 'incremental-repack', 'commit-graph'])
    expect(plan(v('2.29.0'), FRAGMENTED)).toEqual({ kind: 'skip', reason: 'unsupported' })
  })

  it('asks Git 2.54+ to confirm a full clone’s pack-count trigger only', () => {
    const confirm = (
      version: string,
      probe: ObjectStoreProbe,
      partialClone = false
    ): boolean | undefined => {
      const result = plan(v(version), probe, { partialClone })
      return result.kind === 'run' ? result.confirmGeometric : undefined
    }
    expect(confirm('2.53.1', FRAGMENTED)).toBe(false)
    expect(confirm('2.54.0', FRAGMENTED)).toBe(true)
    expect(confirm('2.54.0', { ...FRAGMENTED, looseObjects: LOOSE_OBJECT_THRESHOLD })).toBe(false)
    // Git's estimate ignores promisor packs, so it would veto exactly the backlog Orca creates.
    expect(confirm('2.54.0', FRAGMENTED, true)).toBe(false)
  })

  it('marks a huge first catch-up as a backlog', () => {
    const backlog = (probe: ObjectStoreProbe): boolean | undefined => {
      const result = plan(v('2.55.0'), probe)
      return result.kind === 'run' ? result.backlog : undefined
    }
    expect(backlog(FRAGMENTED)).toBe(false)
    expect(backlog({ ...CLEAN, packCount: OBJECT_BACKLOG_PACK_COUNT })).toBe(true)
    expect(backlog({ ...CLEAN, looseObjects: 3_000_000, looseBytes: 3.2 * 1024 ** 3 })).toBe(true)
  })

  it('respects tasks the user disabled in config', () => {
    const result = plan(v('2.55.0'), FRAGMENTED, { disabled: ['commit-graph'] })
    expect(result.kind === 'run' && result.tasks).toEqual(['loose-objects', 'geometric-repack'])
  })

  it('reads vendor-suffixed version strings', () => {
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual({
      major: 2,
      minor: 39,
      patch: 5
    })
    expect(parseGitVersion('git version 2.53.0.windows.1')?.minor).toBe(53)
    expect(parseGitVersion('not git')).toBeUndefined()
  })
})
