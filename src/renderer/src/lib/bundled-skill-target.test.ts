import { describe, expect, it } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { bundledSkillTargetKey, resolveBundledSkillTarget } from './bundled-skill-target'

const WSL_PROJECT: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'p',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'p:wsl:Ubuntu'
  }
}

describe('resolveBundledSkillTarget', () => {
  it('plans nothing until the owning runtime is known', () => {
    expect(resolveBundledSkillTarget(null, undefined)).toBeNull()
  })

  it('sends a paired server or SSH host to that host, whatever the local project says', () => {
    const target = resolveBundledSkillTarget(
      { kind: 'environment', environmentId: 'env-1' },
      WSL_PROJECT
    )
    expect(target).toEqual({ kind: 'environment', environmentId: 'env-1' })
    expect(bundledSkillTargetKey(target!)).toBe('runtime:env-1')
  })

  it('sends a Windows project that runs in WSL to the guest', () => {
    const target = resolveBundledSkillTarget({ kind: 'local' }, WSL_PROJECT)
    expect(target).toEqual({ kind: 'wsl', distro: 'Ubuntu' })
    expect(bundledSkillTargetKey(target!)).toBe('wsl:Ubuntu')
  })

  it('plans nothing while a WSL project needs its distro repaired, never the Windows home', () => {
    expect(
      resolveBundledSkillTarget(
        { kind: 'local' },
        {
          status: 'repair-required',
          repair: {
            projectId: 'p',
            preferredRuntime: { kind: 'wsl', distro: 'Gone' },
            reason: 'wsl-distro-missing',
            source: 'project-override',
            cacheKey: 'p:repair'
          }
        }
      )
    ).toBeNull()
  })

  it('plans this machine otherwise', () => {
    expect(resolveBundledSkillTarget({ kind: 'local' }, undefined)).toEqual({ kind: 'local' })
  })
})
