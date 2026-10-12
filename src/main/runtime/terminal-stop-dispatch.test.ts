import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RuntimeMachineName } from './runtime-machine-name'
import type { ExplicitCloseStop } from './session-tabs/explicit-terminal-close-stops'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'
import type { OrcaRuntimeWithStopExactTerminalsForWorktree } from './orca-runtime-stop-exact-terminals-for-worktree'

class StopRuntime extends OrcaRuntimeService {
  closeStop: ExplicitCloseStop | null = null

  acquireEmptySpawn() {
    return this.acquireWorktreeTerminalSpawn()
  }

  emptyExplicitStop() {
    return this.stopExplicitlyClosedTabPtys([], 'unaddressed')
  }

  leafHandle() {
    const leaf = this.leaves.values().next().value
    if (!leaf) {
      throw new Error('fixture leaf missing')
    }
    return this.issueHandle(leaf)
  }

  protected override describeTerminalClose(
    handle: string,
    tabId: string,
    ptyId: string | null,
    stop: ExplicitCloseStop
  ) {
    this.closeStop = stop
    return super.describeTerminalClose(handle, tabId, ptyId, stop)
  }

  commitSleep(
    ...args: Parameters<
      OrcaRuntimeWithStopExactTerminalsForWorktree['commitWorktreeTerminalSleepPtys']
    >
  ) {
    return this.commitWorktreeTerminalSleepPtys(...args)
  }
}

beforeEach(() => {
  vi.spyOn(RuntimeMachineName.prototype, 'start').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('terminal stop runtime callback binding', () => {
  it('captures the event method before the nested sleep receipt changes it', () => {
    const runtime = new StopRuntime()
    const events: string[] = []
    const replacement = vi.fn()
    Object.defineProperty(runtime, 'emitClientEvent', {
      configurable: true,
      get() {
        events.push('event-read')
        return function (this: StopRuntime, event: RuntimeClientEvent) {
          expect(this).toBe(runtime)
          expect(arguments.length).toBe(1)
          expect(event).toEqual({
            type: 'worktreeTerminalSleepState',
            worktreeId: 'folder-proof',
            generation: 7,
            phase: 'committed',
            ptyIds: ['pty-proof'],
            terminalHandles: ['term-proof']
          })
          events.push('event-call')
        }
      }
    })
    const handles = { 'pty-proof': ['term-proof'] }
    Object.defineProperty(runtime, 'getRecordedTerminalSleepHandles', {
      get() {
        events.push('handles-read')
        return function (
          this: StopRuntime,
          ptyIds: Iterable<string>,
          terminalHandlesByPtyId: Readonly<Record<string, readonly string[]>>
        ) {
          expect(this).toBe(runtime)
          expect(arguments.length).toBe(2)
          expect([...ptyIds]).toEqual(['pty-proof'])
          expect(terminalHandlesByPtyId).toBe(handles)
          events.push('handles-call')
          Object.defineProperty(runtime, 'emitClientEvent', {
            configurable: true,
            value: replacement
          })
          return ['term-proof']
        }
      }
    })
    const pendingPtyIds = new Set(['pty-proof'])
    const committedPtyIds = new Set<string>()
    runtime.commitSleep({
      worktreeId: 'folder-proof',
      generation: 7,
      ptyIds: ['pty-proof'],
      pendingPtyIds,
      committedPtyIds,
      terminalHandlesByPtyId: handles
    })
    expect(events).toEqual(['event-read', 'handles-read', 'handles-call', 'event-call'])
    expect(replacement).not.toHaveBeenCalled()
    expect([...pendingPtyIds]).toEqual([])
    expect([...committedPtyIds]).toEqual(['pty-proof'])
  })
})

function runtimeWithUnspawnedLeaf() {
  const runtime = new StopRuntime()
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'unspawned-tab',
        worktreeId: 'folder-proof',
        title: 'Unspawned shell',
        activeLeafId: 'unspawned-leaf',
        layout: { type: 'leaf', leafId: 'unspawned-leaf' }
      }
    ],
    leaves: [
      {
        tabId: 'unspawned-tab',
        worktreeId: 'folder-proof',
        leafId: 'unspawned-leaf',
        paneRuntimeId: 1,
        ptyId: null
      }
    ]
  })
  return runtime
}

describe('closing a leaf before its PTY exists', () => {
  it('returns the close receipt without requiring a PTY stop', async () => {
    const runtime = runtimeWithUnspawnedLeaf()
    await expect(runtime.closeTerminal(runtime.leafHandle())).resolves.toEqual({
      handle: runtime.leafHandle(),
      tabId: 'unspawned-tab',
      ptyKilled: false
    })
    expect(runtime.closeStop).toEqual({ stopped: false })
  })

  it('uses the same stop result as an empty explicit stop', async () => {
    const runtime = runtimeWithUnspawnedLeaf()
    const stop = await runtime.emptyExplicitStop()
    await runtime.closeTerminal(runtime.leafHandle())
    expect(runtime.closeStop).toBe(stop)
  })
})

describe('terminal stop commands during runtime construction', () => {
  it('reads the canonical empty sleep state before command fields initialize', () => {
    class EarlySleepStateRuntime extends StopRuntime {
      protected override get canonicalFetchKeyCache() {
        expect(this.isWorktreeTerminalSleepHeld('folder-proof')).toBe(false)
        return super.canonicalFetchKeyCache
      }
    }
    expect(() => new EarlySleepStateRuntime()).not.toThrow()
  })

  it('returns the original no-op spawn promise before command fields initialize', async () => {
    let release: Promise<() => void> | undefined
    class EarlySpawnRuntime extends StopRuntime {
      protected override get canonicalFetchKeyCache() {
        release = this.acquireEmptySpawn()
        return super.canonicalFetchKeyCache
      }
    }
    expect(() => new EarlySpawnRuntime()).not.toThrow()
    expect(release).toBeInstanceOf(Promise)
    await expect(release).resolves.toBeTypeOf('function')
  })

  it('returns the empty stop promise from the original constructor seam', async () => {
    let stopped: Promise<ExplicitCloseStop> | undefined
    class EarlyEmptyStopRuntime extends StopRuntime {
      protected override get canonicalFetchKeyCache() {
        stopped = this.emptyExplicitStop()
        return super.canonicalFetchKeyCache
      }
    }
    expect(() => new EarlyEmptyStopRuntime()).not.toThrow()
    expect(stopped).toBeInstanceOf(Promise)
    await expect(stopped).resolves.toEqual({ stopped: false })
  })

  it('keeps a null-store sleep refusal as a rejected promise during construction', async () => {
    let sleeping: ReturnType<OrcaRuntimeService['sleepTerminalsForWorktree']> | undefined
    class EarlySleepRefusalRuntime extends StopRuntime {
      protected override get canonicalFetchKeyCache() {
        sleeping = this.sleepTerminalsForWorktree('folder-proof')
        return super.canonicalFetchKeyCache
      }
    }
    expect(() => new EarlySleepRefusalRuntime()).not.toThrow()
    expect(sleeping).toBeInstanceOf(Promise)
    await expect(sleeping).rejects.toThrow('selector_not_found')
  })
})
