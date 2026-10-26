// @vitest-environment happy-dom
// JS joins the existing node/web fixtures without importing either graph into the other's TS project.
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { confirmedPinnedClose } from '../../src/main/runtime/orca-runtime-original-terminal-close-store.test'
import { makeSession } from '../../src/main/runtime/__fixtures__/orca-runtime-terminal-close-continuity-state-fixture'
import { capturedPinnedTerminalCloseRequest } from '../../src/shared/__fixtures__/captured-pinned-terminal-close.test-fixture'
import { TerminalClose } from '../../src/shared/rpc-contract/terminal-unary-params'
import { createGlobalSettingsFixture } from '../../src/shared/global-settings-test-fixture'
import { useAppStore } from '../../src/renderer/src/store'
import {
  ensurePtyDispatcher,
  reattachPtyDispatcherPushListeners
} from '../../src/renderer/src/components/terminal-pane/pty-dispatcher'
import { closeTerminalTab } from '../../src/renderer/src/components/terminal/terminal-tab-actions'
import { onActiveTerminalPaneCloseRequest } from '../../src/renderer/src/components/terminal-pane/request-active-terminal-pane-close'
import { mountedOwner } from '../../src/renderer/src/components/terminal-pane/terminal-presentation-retirement.test-fixture'
import { registerMobileAndTerminalCloseIpcBridge } from '../../src/renderer/src/hooks/ipc-events/mobile-terminal-close-ipc-bridge'
import { useHeldTerminalNotice } from '../../src/renderer/src/components/native-chat/native-chat-held-terminal'
import { structuredSessionNotices } from '../../src/renderer/src/components/native-chat/native-chat-structured-session-notices'
import { NativeChatComposerNotices } from '../../src/renderer/src/components/native-chat/NativeChatComposerNotices'

vi.mock('../../src/renderer/src/runtime/sync-runtime-graph', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
// Reveal/focus is outside the notifier/retirement experiment; invoking chat selection is retained.
vi.mock('../../src/renderer/src/lib/reveal-terminal-pane', () => ({
  revealTerminalPane: () => true
}))

const initial = useAppStore.getState()
const unsubs = []
afterEach(() => {
  cleanup()
  for (const stop of unsubs.splice(0).toReversed()) {
    stop()
  }
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

it.each([
  [false, false],
  [true, true]
])(
  'joins consent, physical exit, actual %s renderer ACK, durable reload and normal Retry (main=%s)',
  async (mounted, main) => {
    const original = capturedPinnedTerminalCloseRequest().originalPresentation.identity
    const { tabId, worktreeId, leafId, ptyId, incarnationId } = original
    const terminal = { paneKey: `${tabId}:${leafId}`, worktreeId, incarnationId }
    const retry = vi.fn()
    const pin = vi.fn()
    const responses = []
    const sent = []
    const persisted = []
    const exits = new Set()
    let receive
    let pending
    let source
    let host
    let physicalExit = false
    const closeResult = Promise.withResolvers()
    closeResult.promise.catch(() => {})
    const api = {
      runtime: {
        call: vi.fn(async ({ method, params }) => {
          if (method === 'terminal.resolvePane') {
            return { ok: true, result: { terminal: host.resolve() } }
          }
          try {
            expect(method).toBe('terminal.close')
            expect(TerminalClose.parse(params)).toEqual(
              TerminalClose.parse(capturedPinnedTerminalCloseRequest(source.handle))
            )
            const result = await host.dispatch(params)
            closeResult.resolve(result)
            return result
          } catch (error) {
            closeResult.reject(error)
            throw error
          }
        })
      },
      pty: {
        onSpawned: () => () => {},
        onData: () => () => {},
        onReplay: () => () => {},
        onExit: (fn) => {
          exits.add(fn)
          return () => exits.delete(fn)
        }
      },
      session: {
        set: async (state) => {
          persisted.push(state)
        },
        flush: vi.fn(async () => {})
      },
      ui: {
        onOpenFileFromMobile: () => () => {},
        onOpenDiffFromMobile: () => () => {},
        onCloseTerminal: () => () => {},
        onWorkspaceSleep: () => () => {},
        onResumeSleepingAgents: () => () => {},
        onTerminalTabCloseRequest: (fn) => {
          receive = fn
          return () => {
            receive = undefined
          }
        },
        respondTerminalTabClose: (response) => {
          responses.push(response)
          if (response.error) {
            pending.reject(new Error(response.error))
          } else {
            pending.resolve()
          }
        }
      }
    }
    vi.stubGlobal('api', api)
    ensurePtyDispatcher()
    reattachPtyDispatcherPushListeners()
    useAppStore.setState(useAppStore.getInitialState(), true)
    const session = makeSession()
    useAppStore.setState({
      settings: createGlobalSettingsFixture({ confirmClosePinnedTab: true }),
      requestPinnedTabCloseConfirm: pin,
      tabsByWorktree: session.tabsByWorktree,
      ptyIdsByTabId: { [tabId]: [ptyId] },
      terminalPtyIncarnationsByPaneKey: session.terminalPtyIncarnationsByPaneKey,
      terminalLayoutsByTabId: session.terminalLayoutsByTabId
    })
    const holder = useAppStore.getState().createUnifiedTab(worktreeId, 'terminal', {
      id: tabId,
      entityId: tabId,
      executionHostId: 'local'
    })
    useAppStore.getState().pinTab(holder.id, { recordInteraction: false })
    const chat = useAppStore.getState().createUnifiedTab(worktreeId, 'agent-session', {
      entityId: 'invoking-chat',
      executionHostId: 'local'
    })
    useAppStore.getState().activateTab(chat.id, { worktreeId, recordFocus: false })
    const slot = () =>
      useAppStore
        .getState()
        .groupsByWorktree[worktreeId]?.map(({ id, activeTabId }) => ({ id, activeTabId }))
    const beforeSlot = slot()
    if (mounted) {
      const owner = mountedOwner(false, { tabId, worktreeId, leafId, ptyId })
      unsubs.push(owner.unregister)
    }
    unsubs.push(
      onActiveTerminalPaneCloseRequest(tabId, (options) =>
        closeTerminalTab(tabId, { ...options, skipRunningProcessConfirm: true })
      )
    )
    registerMobileAndTerminalCloseIpcBridge(unsubs, vi.fn())
    function LaunchNotice() {
      const heldTerminal = useHeldTerminalNotice(terminal, 'local', 'Codex')
      return createElement(NativeChatComposerNotices, {
        notices: structuredSessionNotices({
          launch: {
            lifecycle: 'failed',
            failure: {
              kind: 'refused',
              code: 'agent_session_operation_invalid',
              details: { reason: 'conversationOpenInTerminal' },
              terminal
            },
            retry
          },
          agentLabel: 'Codex',
          sessionError: null,
          composerError: null,
          heldTerminal
        })
      })
    }
    await confirmedPinnedClose(main, {
      notify: async (target, options) => {
        expect(physicalExit).toBe(true)
        sent.push(options)
        pending = Promise.withResolvers()
        receive({ requestId: 'joined-close', tabId: target, ...options })
        await pending.promise
      },
      onExit: () => {
        physicalExit = true
        act(() => {
          // The host confirmed this exact incarnation; keep the original topology while clearing its dead binding.
          const state = useAppStore.getState()
          state.clearTabPtyId(tabId, ptyId)
          const { ptyIdsByLeafId: _bindings, ...layout } = state.terminalLayoutsByTabId[tabId]
          state.setTabLayout(tabId, layout)
          for (const fn of exits) {
            fn({ id: ptyId, code: 0, incarnationId })
          }
        })
        expect(useAppStore.getState().tabsByWorktree[worktreeId][0].ptyId).toBeNull()
        expect(useAppStore.getState().terminalLayoutsByTabId[tabId]).toBeDefined()
      },
      run: async (input) => {
        host = input
        source = input.source
        render(createElement(LaunchNotice))
        const button = await screen.findByRole('button', { name: 'Close terminal' })
        fireEvent.click(button)
        await waitFor(() => expect(pin).toHaveBeenCalledOnce())
        act(() => pin.mock.calls[0][0].onCancel())
        await waitFor(() => expect(button.disabled).toBe(false))
        expect(physicalExit).toBe(false)
        expect(sent).toEqual([])
        fireEvent.click(button)
        await waitFor(() => expect(pin).toHaveBeenCalledTimes(2))
        expect(button.disabled).toBe(true)
        await act(async () => pin.mock.calls[1][0].onConfirm())
        const result = await closeResult.promise
        // Distinguish successful process completion from the renderer's real admission/ACK and host result.
        expect(physicalExit).toBe(true)
        expect(responses).toEqual([{ requestId: 'joined-close' }])
        expect(sent[0].force).toBe(true)
        expect(result).toMatchObject({ ok: true, result: { close: { ptyKilled: true } } })
        return result
      }
    })
    expect(useAppStore.getState().tabsByWorktree[worktreeId]).toEqual([])
    expect(useAppStore.getState().terminalLayoutsByTabId[tabId]).toBeUndefined()
    expect(persisted.at(-1).tabsByWorktree[worktreeId]).toEqual([])
    expect(api.session.flush).toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' }).disabled).toBe(false))
    expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Fixture shell' })).toBeNull()
    expect(retry).not.toHaveBeenCalled()
    expect(
      useAppStore.getState().unifiedTabsByWorktree[worktreeId].some((tab) => tab.id === chat.id)
    ).toBe(true)
    expect(slot()).toEqual(beforeSlot)
    expect(
      api.runtime.call.mock.calls
        .filter(([request]) => request.method !== 'terminal.resolvePane')
        .map(([request]) => request.method)
    ).toEqual(['terminal.close'])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  }
)
