import '../rpc/unused-default-rpc-methods.test-fixture'
import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { WorkspacePortExecutionHostDeps } from '../../ports/workspace-port-execution-host'
import type { WorkspacePortProbe } from '../../../shared/workspace-ports'

describe('workspace ports during runtime construction', () => {
  it('creates lazy port capabilities before later constructor fields initialize', async () => {
    let ports: WorkspacePortExecutionHostDeps | undefined
    class ConstructionRuntime extends OrcaRuntimeService {
      protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        ports = this.getWorkspacePortHostDeps()
        return super.canonicalFetchKeyCache
      }
    }
    expect(() => new ConstructionRuntime(null)).not.toThrow()
    expect(Object.keys(ports ?? {})).toEqual(['getLocalProbes'])
    await expect(ports?.getLocalProbes()).rejects.toThrow('runtime_unavailable')
  })

  it('keeps the original asynchronous missing-store refusal during construction', async () => {
    let probes: Promise<WorkspacePortProbe[]> | undefined
    class ConstructionRuntime extends OrcaRuntimeService {
      protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        probes = this.getWorkspacePortProbes()
        return super.canonicalFetchKeyCache
      }
    }
    expect(() => new ConstructionRuntime(null)).not.toThrow()
    await expect(probes).rejects.toThrow('runtime_unavailable')
  })
})
