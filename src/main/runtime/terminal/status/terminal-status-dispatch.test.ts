import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeTerminalAgentStatusSnapshot } from '../../runtime-terminal-agent-status-query'

describe('terminal status call evaluation', () => {
  it('captures the current permission method before reading wait inputs', () => {
    const runtime = new OrcaRuntimeService(null)
    const events: string[] = []
    const terminal: RuntimeTerminalAgentStatusSnapshot = {
      waitText: '',
      waitBlockedAt: null,
      title: null,
      titleStatus: null,
      titleStatusIsLive: false
    }
    Object.defineProperties(runtime, {
      assertLiveTerminalHandleTargetsPty: { value: () => undefined },
      getFreshExplicitAgentStatusForPty: { value: () => null },
      getPtyTitleDisplayClear: { value: () => null },
      hasAuthoritativeTerminalWaitPermission: {
        configurable: true,
        get: () => {
          events.push('read-permission-method')
          return function (this: OrcaRuntimeService, actual: RuntimeTerminalAgentStatusSnapshot) {
            expect(this).toBe(runtime)
            expect(actual).toBe(terminal)
            return true
          }
        }
      },
      getTerminalWaitPermissionInputs: {
        value: () => ({
          get terminal() {
            events.push('read-terminal')
            Object.defineProperty(runtime, 'hasAuthoritativeTerminalWaitPermission', {
              value: () => {
                throw new Error('permission method replaced by an argument getter')
              }
            })
            return terminal
          },
          get lifecycle() {
            events.push('read-lifecycle')
            return null
          }
        })
      }
    })
    expect(runtime['getAgentPromptActivity']('handle', 'pty').status).toBe('permission')
    expect(events).toEqual(['read-permission-method', 'read-terminal', 'read-lifecycle'])
  })

  it('keeps hook callback selection late for each returned pane', async () => {
    const runtime = new OrcaRuntimeService(null)
    const events: string[] = []
    Object.defineProperty(runtime, 'checkHookAgentPresenceFn', {
      configurable: true,
      value: function (this: OrcaRuntimeService, paneKey: string) {
        expect(this).toBe(runtime)
        events.push(`first:${paneKey}`)
        Object.defineProperty(runtime, 'checkHookAgentPresenceFn', {
          value: function (this: OrcaRuntimeService, nextKey: string) {
            expect(this).toBe(runtime)
            events.push(`replacement:${nextKey}`)
            return Promise.resolve('unverifiable')
          }
        })
        return Promise.resolve('exited')
      }
    })
    Object.defineProperty(runtime, 'collectAgentStatusPaneKeysForPty', {
      value: () => new Set(['first', 'second'])
    })
    await expect(runtime['recheckHookAgentPresenceForPty']('pty')).resolves.toBe('unverifiable')
    expect(events).toEqual(['first:first', 'replacement:second'])
  })

  it('uses the explicit status replacement after a foreground await', async () => {
    const runtime = new OrcaRuntimeService(null)
    const pty = runtime['recordPtyWorktree']('pty', 'workspace')
    runtime['handleByPtyId'].set('pty', 'handle')
    pty.lastAgentStatusObservedLive = true
    Object.defineProperty(runtime, 'recheckHookAgentPresenceForPty', {
      value: () => Promise.resolve('unverifiable')
    })
    const foreground = Promise.withResolvers<{
      controller: null
      available: boolean
      process: string | null
    }>()
    Object.defineProperty(runtime, 'readPtyForegroundProcessFromController', {
      value: () => foreground.promise
    })
    Object.defineProperty(runtime, 'getFreshExplicitAgentStatusForPty', {
      configurable: true,
      value: () => ({ status: 'idle', updatedAt: 1, stateStartedAt: 1 })
    })
    const reads = vi.fn(function (this: OrcaRuntimeService, handle: string, ptyId: string) {
      expect(this).toBe(runtime)
      expect([handle, ptyId]).toEqual(['handle', 'pty'])
      return { status: 'working', updatedAt: 2, stateStartedAt: 2 }
    })
    runtime['confirmPtyAgentExit']('pty', true)
    await Promise.resolve()
    Object.defineProperty(runtime, 'getFreshExplicitAgentStatusForPty', { value: reads })
    foreground.resolve({ controller: null, available: true, process: 'bash' })
    await foreground.promise
    expect(reads).toHaveBeenCalledOnce()
  })

  it('keeps the original rejection when a late hook callback becomes null during iteration', async () => {
    const runtime = new OrcaRuntimeService(null)
    const events: string[] = []
    let callback: (typeof runtime)['checkHookAgentPresenceFn'] = function (
      this: OrcaRuntimeService,
      paneKey: string
    ) {
      expect(this).toBe(runtime)
      expect(arguments).toHaveLength(1)
      events.push(`invoke:${paneKey}`)
      callback = null
      return Promise.resolve('exited')
    }
    Object.defineProperty(runtime, 'checkHookAgentPresenceFn', {
      get: () => {
        events.push('read-hook')
        return callback
      }
    })
    Object.defineProperty(runtime, 'collectAgentStatusPaneKeysForPty', {
      value: () => {
        events.push('collect')
        return new Set(['first', 'second'])
      }
    })
    await expect(runtime['recheckHookAgentPresenceForPty']('pty')).rejects.toThrow(TypeError)
    expect(events).toEqual(['read-hook', 'collect', 'read-hook', 'invoke:first', 'read-hook'])
  })
})
