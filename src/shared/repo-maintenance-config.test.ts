import { describe, expect, it } from 'vitest'
import { parseRepoMaintenanceConfig, readRepoMaintenanceConfig } from './repo-maintenance-config'

const read = (output: string, repoPaths: string[] = ['/work/repo']) =>
  readRepoMaintenanceConfig(parseRepoMaintenanceConfig(output), repoPaths)

describe('repo maintenance config', () => {
  it('does not read the maintenance.auto=false that scheduler registration writes as an opt-out', () => {
    expect(
      read('local\tmaintenance.auto false\nlocal\tmaintenance.strategy incremental\n').optOut
    ).toBeNull()
  })

  it('treats a registered repo as owned by its external scheduler', () => {
    expect(read('global\tmaintenance.repo /work/repo/\n').optOut).toBe('external_scheduler')
    expect(read('global\tmaintenance.repo /work/other\n').optOut).toBeNull()
    expect(read('global\tmaintenance.repo C:\\Work\\Repo\n', ['c:/work/repo']).optOut).toBe(
      'external_scheduler'
    )
  })

  it('honours gc.auto=0 only from repo, worktree or global config, with later values winning', () => {
    expect(read('local\tgc.auto 0\n').optOut).toBe('gc_auto_disabled')
    expect(read('global\tgc.auto 0k\n').optOut).toBe('gc_auto_disabled')
    expect(read('gc.auto 0\n').optOut).toBe('gc_auto_disabled')
    expect(read('system\tgc.auto 0\n').optOut).toBeNull()
    expect(read('command\tgc.auto 0\n').optOut).toBeNull()
    expect(read('global\tgc.auto 0\nlocal\tgc.auto 6700\n').optOut).toBeNull()
  })

  it('honours maintenance.strategy=none', () => {
    expect(read('local\tmaintenance.strategy none\n').optOut).toBe('strategy_none')
    expect(
      read('global\tmaintenance.strategy none\nlocal\tmaintenance.strategy geometric\n').optOut
    ).toBeNull()
  })

  it('detects partial clones and per-task disables', () => {
    const config = read(
      'local\tremote.origin.promisor true\nglobal\tmaintenance.commit-graph.enabled false\n' +
        'global\tmaintenance.loose-objects.enabled false\nlocal\tmaintenance.loose-objects.enabled true\n'
    )
    expect(config.partialClone).toBe(true)
    expect([...config.disabledTasks]).toEqual(['commit-graph'])
    expect(read('local\textensions.partialclone origin\n').partialClone).toBe(true)
    expect(read('local\tremote.origin.promisor false\n').partialClone).toBe(false)
  })
})
