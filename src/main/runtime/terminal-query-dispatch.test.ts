import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { RuntimePtyTabCloseAuthority } from './runtime-terminal-state-records'

class QueryDispatchRuntime extends OrcaRuntimeService {
  prepareMobileCreate() {
    this.registerPty('pty-query', 'workspace')
    const pty = this.ptysById.get('pty-query')
    if (!pty) {
      throw new Error('missing_test_pty')
    }
    pty.tabId = 'tab'
    pty.paneKey = makePaneKey('tab', '00000000-0000-4000-8000-000000000001')
    this.pendingMobileTerminalCreatesByKey.set('workspace::tab', {
      activate: false,
      paired: false,
      selectIfNoActiveTab: false
    })
    return pty
  }

  ensureSurface() {
    return this.ensurePtyBackedMobileSurfaceForRendererTab('workspace', 'tab')
  }

  resolveAuthority(authority: RuntimePtyTabCloseAuthority) {
    return this.resolvePtyTabCloseSurfaceAuthority(authority)
  }

  outputCallbacks() {
    return this.terminalOutput.host
  }
}

afterEach(() => vi.restoreAllMocks())

describe('terminal query dispatch', () => {
  it('preserves the two arguments in both protected mobile surface lookups', () => {
    const runtime = new QueryDispatchRuntime(null)
    const pty = runtime.prepareMobileCreate()
    const find = vi.fn(function (this: typeof runtime) {
      expect(this).toBe(runtime)
      expect(arguments.length).toBe(2)
      return null
    })
    Object.defineProperty(runtime, 'findMobileTerminalSurface', { value: find })
    Object.defineProperty(runtime, 'findLiveRegisteredPtyForRendererTab', { value: () => pty })
    Object.defineProperty(runtime, 'publishPtyBackedMobileSessionTerminal', { value: () => {} })

    try {
      expect(runtime.ensureSurface()).toBeNull()
      expect(find).toHaveBeenCalledTimes(2)
      expect(pty.runtimeSessionOwned).toBe(true)
    } finally {
      runtime.onPtyExit('pty-query', 0)
    }
  })

  it('captures the protected live PTY lookup before reading authority.handle', () => {
    const runtime = new QueryDispatchRuntime(null)
    const original = vi.fn(function (this: typeof runtime) {
      expect(this).toBe(runtime)
      expect(arguments.length).toBe(1)
      return null
    })
    const replacement = vi.fn(() => null)
    Object.defineProperty(runtime, 'getLivePtyForHandle', {
      configurable: true,
      get: () => original
    })
    const authority: RuntimePtyTabCloseAuthority = {
      get handle() {
        Object.defineProperty(runtime, 'getLivePtyForHandle', { value: replacement })
        return 'handle'
      },
      ptyId: 'pty-query',
      incarnationId: null,
      worktreeId: 'workspace'
    }

    expect(runtime.resolveAuthority(authority)).toBeNull()
    expect(original).toHaveBeenCalledExactlyOnceWith('handle')
    expect(replacement).not.toHaveBeenCalled()
  })

  it.each([
    ['seedHeadlessTerminal', 4],
    ['resizeHeadlessTerminal', 3],
    ['trackHeadlessTerminalData', 3]
  ] as const)('captures recovery %s before its argument getters', (method, argc) => {
    const runtime = new QueryDispatchRuntime(null)
    const original = vi.fn(function (this: typeof runtime) {
      expect(this).toBe(runtime)
      expect(arguments.length).toBe(argc)
    })
    const replacement = vi.fn()
    Object.defineProperty(runtime, 'disposeHeadlessTerminal', { value: () => {} })
    Object.defineProperty(runtime, 'seedHeadlessTerminal', { configurable: true, value: () => {} })
    Object.defineProperty(runtime, 'resizeHeadlessTerminal', {
      configurable: true,
      value: () => {}
    })
    Object.defineProperty(runtime, 'trackHeadlessTerminalData', {
      configurable: true,
      value: () => {}
    })
    Object.defineProperty(runtime, method, { get: () => original })
    const replace = () => Object.defineProperty(runtime, method, { value: replacement })
    let reads = 0
    Object.defineProperty(runtime, 'getTerminalSize', {
      value: () => ({
        get cols() {
          if (method === 'resizeHeadlessTerminal') {
            replace()
          }
          return 100
        },
        rows: 40
      })
    })

    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
      'pty-query',
      {
        get data() {
          if (++reads === 2 && method === 'seedHeadlessTerminal') {
            replace()
          }
          return 'snapshot'
        },
        cols: 80,
        rows: 24
      },
      [
        {
          get data() {
            if (method === 'trackHeadlessTerminalData') {
              replace()
            }
            return 'tail'
          },
          seq: 7
        }
      ]
    )

    expect(original).toHaveBeenCalledOnce()
    expect(replacement).not.toHaveBeenCalled()
  })

  it.each(['resizeHeadlessTerminal', 'trackHeadlessTerminalData'] as const)(
    'preserves invoke-time lookup for the pre-existing output %s callback',
    (method) => {
      const runtime = new QueryDispatchRuntime(null)
      const callbacks = runtime.outputCallbacks()
      const resize = callbacks.resizeHeadlessTerminal
      const track = callbacks.trackHeadlessTerminalData
      const original = vi.fn()
      const replacement = vi.fn(function (this: typeof runtime) {
        expect(this).toBe(runtime)
        expect(arguments.length).toBe(3)
      })
      Object.defineProperty(runtime, method, { configurable: true, value: original })
      const argument = {
        get value() {
          Object.defineProperty(runtime, method, { value: replacement })
          return 'pty-query'
        }
      }

      if (method === 'resizeHeadlessTerminal') {
        resize(argument.value, 80, 24)
      } else {
        track(argument.value, 'tail', 7)
      }

      expect(original).not.toHaveBeenCalled()
      expect(replacement).toHaveBeenCalledOnce()
    }
  )
})
