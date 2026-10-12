import { expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { OrcaRuntimeService } from './orca-runtime'
import type { Repo } from '../../shared/repo-types'
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), isPackaged: false },
  BrowserWindow: { fromId: () => null },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: () => null }
}))
const repo: Repo = {
  id: 'construction-repo',
  path: tmpdir(),
  displayName: 'Construction',
  badgeColor: 'blue',
  addedAt: 1
}
class QueryRuntime extends OrcaRuntimeService {
  checkDraft() {
    return this.buildStartupForDraft(repo, 'startup draft')
  }
  checkAgentGuard() {
    expect(() => this.buildStartupForAgent(repo, 'claude', undefined)).toThrow(
      'runtime_unavailable'
    )
  }
  checkLineage() {
    return this.recordCreatedWorktreeLineage(
      { id: `construction-repo::${tmpdir()}`, instanceId: 'construction-instance' },
      { kind: 'none', warnings: [] }
    )
  }
  checkBackground() {
    return this.shouldProvisionWorktreeInBackground()
  }
  checkProvisioningHost() {
    return Object.keys(this.getWorktreeTerminalProvisioningHost())
  }
  checkReadinessHost() {
    return Object.keys(this.getWorktreeStartupReadinessHost())
  }
}
const cases = [
  {
    name: 'public draft-agent null-store query',
    run: (r: QueryRuntime) => r.resolveStartupDraftAgent(repo),
    check: async (v: unknown) => {
      await expect(v).resolves.toBeNull()
    }
  },
  {
    name: 'protected draft-plan null-store query',
    run: (r: QueryRuntime) => r.checkDraft(),
    check: async (v: unknown) => {
      await expect(v).resolves.toBeNull()
    }
  },
  {
    name: 'protected agent-plan original null-store error',
    run: (r: QueryRuntime) => r.checkAgentGuard(),
    check: async (v: unknown) => {
      expect(v).toBeUndefined()
    }
  },
  {
    name: 'lineage-none projection with valid identities',
    run: (r: QueryRuntime) => r.checkLineage(),
    check: async (v: unknown) => {
      expect(v).toEqual({ lineage: null, workspaceLineage: null, warnings: [] })
    }
  },
  {
    name: 'public base-prefetch original async null-store error',
    run: (r: QueryRuntime) => r.prefetchManagedWorktreeCreateBase({ repoSelector: repo.id }),
    check: async (v: unknown) => {
      await expect(v).rejects.toThrow('runtime_unavailable')
    }
  },
  {
    name: 'background provisioning pure readiness query',
    run: (r: QueryRuntime) => r.checkBackground(),
    check: async (v: unknown) => {
      expect(v).toBe(true)
    }
  },
  {
    name: 'lazy terminal provisioning capability object',
    run: (r: QueryRuntime) => r.checkProvisioningHost(),
    check: async (v: unknown) => {
      expect(v).toEqual([
        'canSpawn',
        'createTerminal',
        'splitTerminal',
        'setTabTitle',
        'setTabColor',
        'getSettings',
        'getPtyId',
        'recordSetupCompletionToken'
      ])
    }
  },
  {
    name: 'lazy startup-readiness capability object',
    run: (r: QueryRuntime) => r.checkReadinessHost(),
    check: async (v: unknown) => {
      expect(v).toEqual([
        'getPtyId',
        'getForegroundProcess',
        'hasChildProcesses',
        'subscribeToData',
        'readRecentOutput',
        'write'
      ])
    }
  },
  {
    name: 'execution-host metadata query permits initial absent record',
    run: (r: QueryRuntime) => r.launchedAgentHostProvesAgent('startup-pty'),
    check: async (v: unknown) => {
      expect(v).toBe(process.platform !== 'win32')
    }
  }
]
for (const test of cases) {
  it(`preserves ${test.name} at existing constructor getter seam`, async () => {
    let result: unknown
    class ConstructionRuntime extends QueryRuntime {
      protected get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        result = test.run(this)
        return new Map()
      }
    }
    expect(() => new ConstructionRuntime(null)).not.toThrow()
    await test.check(result)
  })
}
