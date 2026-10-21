import AsyncStorage from '@react-native-async-storage/async-storage'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TERMINAL_ACCESSORY_KEYS } from '../terminal/terminal-accessory-keys'
import { useMobileSessionLifecycle } from './use-mobile-session-lifecycle'
import { useMobileSessionPreferenceFocus } from './use-mobile-session-preference-focus'
import { useMobileSessionViewMode } from './use-mobile-session-view-mode'

const focusEffects = vi.hoisted(() => ({
  callbacks: new Set<() => void | (() => void)>()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: { OS: 'ios' }
}))
vi.mock('expo-router', async () => {
  const react = await import('react')
  return {
    useFocusEffect: (effect: () => void | (() => void)) => {
      react.useEffect(() => {
        focusEffects.callbacks.add(effect)
        const cleanup = effect()
        return () => {
          focusEffects.callbacks.delete(effect)
          cleanup?.()
        }
      }, [effect])
    }
  }
})
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn() }
}))
vi.mock('../transport/host-store', () => ({ loadHosts: vi.fn().mockResolvedValue([]) }))
vi.mock('../terminal/terminal-foreground-recovery', () => ({
  recoverActiveTerminalAfterForeground: vi.fn(),
  shouldRecoverTerminalOnAppStateChange: () => false
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function sessionScope() {
  return {
    hostId: 'host',
    connState: 'connecting',
    setTerminalTextScale: vi.fn(),
    setAutocompleteEnabled: vi.fn(),
    setTerminalLinkOpenMode: vi.fn(),
    setCustomKeys: vi.fn(),
    setVisibleBuiltInIds: vi.fn(),
    setHostEndpoint: vi.fn(),
    connStateRef: { current: 'connecting' },
    terminalRefs: { current: new Map() },
    initializedHandlesRef: { current: new Set() },
    activeHandleRef: { current: null },
    scheduleDelayedAction: vi.fn(),
    unsubscribeTerminal: vi.fn(),
    subscribeToTerminal: vi.fn()
  }
}

let renderer: ReactTestRenderer | null = null
beforeEach(() => {
  focusEffects.callbacks.clear()
  vi.mocked(AsyncStorage.getItem).mockReset().mockResolvedValue(null)
})
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
})

describe('saved session settings before the first render', () => {
  it('waits for all terminal reads and keeps readiness while Settings changes apply in place', async () => {
    const scale = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockImplementation(async (key) => {
      if (key === 'orca:terminalTextScale') {
        return scale.promise
      }
      if (key === 'orca:terminalAutocompleteEnabled') {
        return 'true'
      }
      if (key === 'orca:terminalLinkOpenMode') {
        return 'phone-browser'
      }
      return null
    })
    const scope = sessionScope()
    let ready = false
    function Harness() {
      ready = useMobileSessionPreferenceFocus(scope).terminalPreferencesReady
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(ready).toBe(false)
    expect(scope.setAutocompleteEnabled).not.toHaveBeenCalled()
    await act(async () => scale.resolve('1.25'))
    expect(ready).toBe(true)
    expect(scope.setTerminalTextScale).toHaveBeenLastCalledWith(1.25)
    expect(scope.setAutocompleteEnabled).toHaveBeenLastCalledWith(true)
    expect(scope.setTerminalLinkOpenMode).toHaveBeenLastCalledWith('phone-browser')

    const nextScale = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockImplementation((key) =>
      key === 'orca:terminalTextScale' ? nextScale.promise : Promise.resolve(null)
    )
    act(() => {
      for (const effect of focusEffects.callbacks) {
        effect()
      }
    })
    expect(ready).toBe(true)
    await act(async () => nextScale.resolve('1.5'))
    expect(ready).toBe(true)
    expect(scope.setTerminalTextScale).toHaveBeenLastCalledWith(1.5)
  })

  it('waits for custom keys and built-in layout before publishing accessory readiness', async () => {
    const keys = deferred<string | null>()
    const layout = deferred<string | null>()
    vi.mocked(AsyncStorage.getItem).mockImplementation((key) =>
      key === 'orca:custom-accessory-keys' ? keys.promise : layout.promise
    )
    const scope = sessionScope()
    let ready = false
    function Harness() {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
      ready = useMobileSessionLifecycle(scope as never).accessoryPreferencesReady
      return null
    }
    act(() => {
      renderer = create(createElement(Harness))
    })
    expect(ready).toBe(false)
    await act(async () => {
      layout.resolve(
        JSON.stringify({
          version: 2,
          orderedBuiltInIds: TERMINAL_ACCESSORY_KEYS.map((key) => key.id),
          visibleBuiltInIds: ['tab']
        })
      )
    })
    expect(scope.setVisibleBuiltInIds).toHaveBeenCalledWith(['tab'])
    expect(ready).toBe(false)
    const saved = [{ id: 'k1', label: 'ls', bytes: 'ls', enter: true }]
    await act(async () => keys.resolve(JSON.stringify(saved)))
    expect(scope.setCustomKeys).toHaveBeenCalledWith(saved)
    expect(ready).toBe(true)
  })

  it('finishes startup with safe defaults when real preference loaders encounter failed storage', async () => {
    vi.mocked(AsyncStorage.getItem).mockRejectedValue(new Error('storage unavailable'))
    const scope = sessionScope()
    let ready = false
    let chat = true
    function Harness() {
      const terminal = useMobileSessionPreferenceFocus(scope)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lifecycle reads only the supplied session members.
      const accessory = useMobileSessionLifecycle(scope as never)
      const view = useMobileSessionViewMode({ hostId: 'host', worktreeId: 'folder:/tmp/project' })
      ready = terminal.terminalPreferencesReady && accessory.accessoryPreferencesReady && view.ready
      chat = view.isTabChatView('tab')
      return null
    }
    await act(async () => {
      renderer = create(createElement(Harness))
    })
    expect(ready).toBe(true)
    expect(chat).toBe(false)
    expect(scope.setTerminalTextScale).toHaveBeenCalledWith(1)
    expect(scope.setAutocompleteEnabled).toHaveBeenCalledWith(false)
    expect(scope.setCustomKeys).toHaveBeenCalledWith([])
    expect(scope.setVisibleBuiltInIds).toHaveBeenCalledWith(
      TERMINAL_ACCESSORY_KEYS.map((key) => key.id)
    )
  })
})
