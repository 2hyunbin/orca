import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

const queries = [
  'surface',
  'ptySurface',
  'ensureSurface',
  'waitSurface',
  'mount',
  'generation',
  'handleGeneration',
  'waitGeneration',
  'handle',
  'waitPty',
  'topology',
  'stats',
  'ui',
  'updateUi',
  'feature',
  'emptyRecovery',
  'closeAuthority',
  'summary',
  'read'
] as const

type ConstructorQuery = (typeof queries)[number]

const refused: Partial<Record<ConstructorQuery, string>> = {
  ui: 'runtime_unavailable',
  updateUi: 'runtime_unavailable',
  feature: 'runtime_unavailable'
}

const rejected: Partial<Record<ConstructorQuery, string>> = {
  waitSurface: 'client_disconnected',
  waitPty: 'request_aborted'
}

function checkResult(query: ConstructorQuery, value: unknown): void {
  if (query === 'summary') {
    expect(value).toMatchObject({ ptyId: 'ctor-pty', worktreeId: 'missing', orphaned: true })
  } else if (query === 'read') {
    expect(value).toMatchObject({ handle: 'ctor-handle', status: 'unknown', tail: [] })
  } else if (query === 'mount' || query === 'waitGeneration') {
    expect(value).toBe(false)
  } else if (query === 'generation' || query === 'handleGeneration') {
    expect(value).toBe(0)
  } else if (query === 'emptyRecovery') {
    expect(value).toBeUndefined()
  } else {
    expect(value).toBeNull()
  }
}

describe('terminal queries during Runtime construction', () => {
  it.each(queries)('preserves %s at the existing cache getter seam', async (query) => {
    let result: unknown
    let error: unknown
    class ConstructorRuntime extends OrcaRuntimeService {
      protected override get canonicalFetchKeyCache(): ReadonlyMap<string, string> {
        try {
          result = this.runQuery(query)
        } catch (caught) {
          error = caught
        }
        return super.canonicalFetchKeyCache
      }

      private runQuery(query: ConstructorQuery): unknown {
        switch (query) {
          case 'surface':
            return this.findMobileTerminalSurface('missing', 'tab')
          case 'ptySurface':
            return this.findMobileTerminalSurfaceForPty('missing', 'pty')
          case 'ensureSurface':
            return this.ensurePtyBackedMobileSurfaceForRendererTab('missing', 'tab')
          case 'waitSurface':
            return this.waitForMobileTerminalSurface('missing', 'tab', {
              signal: AbortSignal.abort()
            })
          case 'mount':
            return this.requestRendererTerminalTabMount('missing')
          case 'generation':
            return this.getRendererTerminalSerializerGeneration('missing')
          case 'handleGeneration':
            return this.getRendererTerminalSerializerGenerationForHandle('missing')
          case 'waitGeneration':
            return this.waitForRendererTerminalSerializer('missing', 0)
          case 'handle':
            return this.resolveHandleForTab('missing')
          case 'waitPty':
            return this.waitForLeafPtyId('missing', 10_000, AbortSignal.abort())
          case 'topology': {
            const topology = this.ptySurfaceTopology()
            expect(topology.graphSequence).toBe(0)
            expect(topology.ptyIdHoldingPane('missing', 'missing')).toBeUndefined()
            return null
          }
          case 'stats':
            return this.getStatsSummary()
          case 'ui':
            return this.getUIState()
          case 'updateUi':
            return this.updateUIState({})
          case 'feature':
            return this.recordFeatureInteraction('browser')
          case 'emptyRecovery':
            return this.replaceHeadlessTerminalFromRendererSnapshotForRecovery('missing', {
              data: '',
              cols: 80,
              rows: 24
            })
          case 'summary':
          case 'read': {
            const pty = this.terminalIdentity.recordPtyWorktree('ctor-pty', 'missing', {
              connected: false
            })
            return query === 'summary'
              ? this.buildPtyTerminalSummary(pty, new Map())
              : this.readPtyTerminal('ctor-handle', pty)
          }
          case 'closeAuthority':
            return this.resolvePtyTabCloseSurfaceAuthority({
              handle: 'missing',
              ptyId: 'missing',
              incarnationId: null,
              worktreeId: 'missing'
            })
        }
      }
    }
    const runtime = new ConstructorRuntime(null)
    if (query === 'summary' || query === 'read') {
      runtime.onPtyExit('ctor-pty', 0)
    }
    const refusal = refused[query]
    if (refusal) {
      expect(error).toBeInstanceOf(Error)
      expect(error).toMatchObject({ message: refusal })
      expect(result).toBeUndefined()
      return
    }
    expect(error).toBeUndefined()
    const rejection = rejected[query]
    if (rejection) {
      expect(result).toBeInstanceOf(Promise)
      await expect(result).rejects.toThrow(rejection)
    } else {
      if (query === 'waitGeneration') {
        expect(result).toBeInstanceOf(Promise)
      }
      checkResult(query, await result)
    }
  })
})
