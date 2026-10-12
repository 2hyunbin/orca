import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime-test-mocks.spec'
import type { RuntimeTerminalCreate, RuntimeTerminalSplit } from '../../../../shared/runtime-types'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'

function scope(): TerminalWorkspaceLaunchScope {
  return {
    id: 'repo::workspace',
    path: '/workspace',
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }
}
function replacement(): never {
  throw new Error('an argument getter replaced an already captured runtime method')
}

describe('launch runtime dispatch and allocation phases', () => {
  it('reenters the split override and captures it before the PTY argument getter', async () => {
    const runtime = new OrcaRuntimeService(null)
    const pty = runtime['recordPtyWorktree']('pty', 'repo::workspace')
    const result: RuntimeTerminalSplit = {
      handle: 'split',
      tabId: 'tab',
      leafId: 'leaf',
      paneRuntimeId: 1
    }
    const events: string[] = []
    Object.defineProperty(runtime, 'splitPtyBackedTerminal', {
      configurable: true,
      get: () => {
        events.push('read-split')
        return async function (
          this: OrcaRuntimeService,
          actual: unknown
        ): Promise<RuntimeTerminalSplit> {
          expect(this).toBe(runtime)
          expect(actual).toBe(pty)
          return result
        }
      }
    })
    Object.defineProperty(runtime, 'getLivePtyForHandle', {
      value: () => ({
        record: null,
        get pty() {
          events.push('read-pty')
          Object.defineProperty(runtime, 'splitPtyBackedTerminal', { value: replacement })
          return pty
        }
      })
    })
    await expect(runtime.splitTerminal('handle')).resolves.toBe(result)
    expect(events).toEqual(['read-split', 'read-pty'])
  })

  it('reenters workspace target resolution on the runtime', async () => {
    const runtime = new OrcaRuntimeService(null)
    const workspace = scope()
    Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchTarget', {
      value: async function (this: OrcaRuntimeService, selector: string) {
        expect(this).toBe(runtime)
        expect(selector).toBe('folder')
        return { scope: workspace, managedWorktree: null }
      }
    })
    await expect(runtime['resolveTerminalWorkspaceLaunchScope']('folder')).resolves.toBe(workspace)
  })

  it('reads reconciliation and its canonical cache after workspace resolution', async () => {
    const runtime = new OrcaRuntimeService(null)
    const ready = Promise.withResolvers<TerminalWorkspaceLaunchScope>()
    const result: RuntimeTerminalCreate = {
      handle: 'adopted',
      worktreeId: 'repo::workspace',
      title: null
    }
    Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchScope', {
      value: () => ready.promise
    })
    const run = vi.fn(async () => result)
    const pending = runtime.dedupeTerminalCreate('device', 'workspace', 'mutation', true, run)
    const events: string[] = []
    Object.defineProperty(runtime, 'reconcileRemoteTerminalCreate', {
      value: async function (
        this: OrcaRuntimeService,
        worktreeId: string,
        _handle: string,
        connection: null
      ) {
        expect(this).toBe(runtime)
        expect(worktreeId).toBe('repo::workspace')
        expect(connection).toBeNull()
        events.push('reconcile')
        return result
      }
    })
    const cache = runtime['terminalCreateIdempotency']
    Object.defineProperty(runtime, 'terminalCreateIdempotency', {
      get: () => {
        events.push('read-cache')
        return cache
      }
    })
    ready.resolve(scope())
    await expect(pending).resolves.toBe(result)
    expect(events).toEqual(['read-cache', 'reconcile'])
    expect(run).not.toHaveBeenCalled()
  })

  it('captures startup and create overrides before option getters', async () => {
    const runtime = new OrcaRuntimeService(null)
    const repo = {
      id: 'repo',
      path: '/workspace',
      displayName: 'repo',
      badgeColor: '#000',
      addedAt: 0
    }
    const terminal: RuntimeTerminalCreate = {
      handle: 'terminal',
      worktreeId: 'repo::workspace',
      title: null
    }
    Object.defineProperty(runtime, 'store', {
      value: { getRepos: () => [repo], getRepo: () => repo }
    })
    Object.defineProperty(runtime, 'resolveWorktreeSelector', {
      value: async () => ({ id: 'repo::workspace', repoId: 'repo', path: '/workspace' })
    })
    const events: string[] = []
    Object.defineProperty(runtime, 'buildStartupForAgent', {
      configurable: true,
      get: () => {
        events.push('read-startup')
        return function (this: OrcaRuntimeService) {
          expect(this).toBe(runtime)
          return { agent: 'codex', startup: { command: 'codex' } }
        }
      }
    })
    Object.defineProperty(runtime, 'createTerminal', {
      configurable: true,
      get: () => {
        events.push('read-create')
        return async function (this: OrcaRuntimeService) {
          expect(this).toBe(runtime)
          return terminal
        }
      }
    })
    await expect(
      runtime.launchAgentTerminal('workspace', {
        get agent(): 'codex' {
          events.push('read-agent')
          Object.defineProperty(runtime, 'buildStartupForAgent', { value: replacement })
          return 'codex'
        },
        prompt: 'prompt',
        get title(): string {
          events.push('read-title')
          Object.defineProperty(runtime, 'createTerminal', { value: replacement })
          return 'title'
        }
      })
    ).resolves.toBe(terminal)
    expect(events).toEqual(['read-startup', 'read-agent', 'read-create', 'read-title'])
  })

  it('captures admission store and controller before spawn argument getters', async () => {
    const runtime = new OrcaRuntimeService(null)
    const expected = new Error('captured controller refusal')
    const admission = vi.fn(async () => undefined)
    const originalStore = { admitTerminalPane: admission }
    let currentStore = originalStore
    const originalController = {
      spawn: async () => {
        throw expected
      }
    }
    let currentController = originalController
    Object.defineProperty(runtime, 'store', { get: () => currentStore })
    Object.defineProperty(runtime, 'ptyController', { get: () => currentController })
    Object.defineProperty(runtime, 'getAvailableAuthoritativeWindow', { value: () => null })
    Object.defineProperty(runtime, 'resolveTerminalWorkspaceLaunchScope', {
      value: async () => scope()
    })
    Object.defineProperty(runtime, 'resolveAgentTerminalCreateOptions', {
      value: async (_workspace: unknown, opts: unknown) => opts
    })
    Object.defineProperty(runtime, 'buildTerminalWorkspaceEnv', { value: async () => ({}) })
    await expect(
      runtime.createTerminal('workspace', {
        get resumeProviderSession() {
          currentStore = {
            admitTerminalPane: vi.fn(async () => {
              throw new Error('late store')
            })
          }
          currentController = {
            spawn: async () => {
              throw new Error('late controller')
            }
          }
          return undefined
        }
      })
    ).rejects.toBe(expected)
    expect(admission).toHaveBeenCalledTimes(1)
  })

  it('rereads the canonical mobile mutation map after creation and in failure cleanup', async () => {
    const runtime = new OrcaRuntimeService(null)
    const first = new Map<string, Promise<never>>()
    const second = new Map<string, Promise<never>>()
    let current = first
    const reads: string[] = []
    Object.defineProperty(runtime, 'mobileTerminalCreateByMutationId', {
      get: () => {
        reads.push(current === first ? 'first' : 'second')
        return current
      }
    })
    const ready = Promise.withResolvers<never>()
    const expected = new Error('creation refusal')
    Object.defineProperty(runtime, 'runCreateMobileSessionTerminal', {
      value: () => {
        current = second
        return ready.promise
      }
    })
    const pending = runtime.createMobileSessionTerminal('workspace', {
      clientMutationId: 'mutation',
      select: false
    })
    expect(first.size).toBe(0)
    expect(second.size).toBe(1)
    ready.reject(expected)
    await expect(pending).rejects.toBe(expected)
    expect(second.size).toBe(0)
    expect(reads).toEqual(['first', 'second', 'second', 'second'])
  })

  it('checks graph readiness on the runtime before resolving its desktop window', async () => {
    const runtime = new OrcaRuntimeService(null)
    const expected = new Error('desktop window refusal')
    const events: string[] = []
    Object.defineProperty(runtime, 'getAvailableAuthoritativeWindow', { value: () => null })
    Object.defineProperty(runtime, 'assertGraphReady', {
      get: () => {
        events.push('read-ready')
        return function (this: OrcaRuntimeService) {
          expect(this).toBe(runtime)
          events.push('invoke-ready')
        }
      }
    })
    Object.defineProperty(runtime, 'getAuthoritativeWindow', {
      value: () => {
        events.push('read-window')
        throw expected
      }
    })
    await expect(runtime.createTerminal()).rejects.toBe(expected)
    expect(events).toEqual(['read-ready', 'invoke-ready', 'read-window'])
  })

  it('retains the canonical cache allocations before their original clock phases', () => {
    const events: { kind: 'map' | 'clock'; value?: object; stack: string }[] = []
    const OriginalMap = Map
    const originalNow = Date.now
    class TracedMap<Key, Value> extends OriginalMap<Key, Value> {
      constructor(entries?: Iterable<readonly [Key, Value]> | null) {
        super(entries)
        events.push({
          kind: 'map',
          value: this,
          stack: new Error('allocation phase trace').stack ?? ''
        })
      }
    }
    vi.stubGlobal('Map', TracedMap)
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
      events.push({ kind: 'clock', stack: new Error('allocation phase trace').stack ?? '' })
      return originalNow()
    })
    try {
      const runtime = new OrcaRuntimeService(null)
      const mobileCache = runtime['mobileTerminalCreateByMutationId']
      const cacheIndex = events.findIndex((event) => event.value === mobileCache)
      const rootClock = events.findIndex((event) => event.kind === 'clock')
      expect(cacheIndex).toBeGreaterThanOrEqual(0)
      expect(rootClock).toBeGreaterThan(cacheIndex)
      expect(
        events.filter(
          (event) =>
            event.kind === 'map' &&
            /terminal\/launch\/(?:mobile-terminal-create|terminal-create-identity)\.ts/.test(
              event.stack
            )
        )
      ).toEqual([])
    } finally {
      clock.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
