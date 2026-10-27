// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import { resolveHeldTerminalTarget, useHeldTerminalNotice } from './native-chat-held-terminal'
import { structuredSessionNotices } from './native-chat-structured-session-notices'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import {
  NativeChatOrcaStopContext,
  type NativeChatOrcaStopView
} from './native-chat-orca-stop-context'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import type * as CloseHoldingTerminalModule from './close-holding-terminal'
import type { RuntimeTerminalResolvePane } from '../../../../shared/runtime-types'
import {
  pairedWriterFixture,
  pairedWriterHoldingTerminal
} from '../../../../shared/__fixtures__/captured-pinned-terminal-close.test-fixture'
const mocks = vi.hoisted(() => ({ reveal: vi.fn(), capture: vi.fn(), close: vi.fn() }))
vi.mock('@/lib/reveal-terminal-pane', () => ({ revealTerminalPane: mocks.reveal }))
vi.mock('./close-holding-terminal', () => ({
  captureHeldTerminal: mocks.capture,
  closeHoldingTerminal: mocks.close
}))
const leaf = '11111111-1111-4111-8111-111111111111'
const original = useAppStore.getState()
const terminal = { paneKey: `terminal:${leaf}`, worktreeId: 'w', incarnationId: 'life' }
const view = {
  hostLabel: null,
  remoteHost: false,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: () => {},
  usageLimitTurnItemId: null,
  continueUsageLimit: () => {},
  heldTerminal: { executionHostId: 'local' as const }
}
const block = {
  type: 'text' as const,
  text: 'Unnamed fallback',
  failure: { kind: 'conversationOpenInTerminal' as const },
  heldByTerminal: terminal
}
const spawned = new Set<(event: { id: string; incarnationId?: string }) => void>()
beforeEach(() => {
  vi.clearAllMocks()
  mocks.capture.mockResolvedValue({ incarnationId: 'life', supportsPinCloseConsent: true })
  vi.stubGlobal('api', {
    pty: {
      onSpawned: (fn: (event: { id: string; incarnationId?: string }) => void) => {
        spawned.add(fn)
        return () => spawned.delete(fn)
      },
      onExit: () => () => {}
    }
  })
  useAppStore.setState({
    tabsByWorktree: {
      w: [
        {
          id: 'terminal',
          worktreeId: 'w',
          title: 'Shell',
          customTitle: 'Review',
          ptyId: 'pty',
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      terminal: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'pty' }
      }
    }
  })
  useAppStore
    .getState()
    .createUnifiedTab('w', 'terminal', { entityId: 'terminal', executionHostId: 'local' })
})
afterEach(() => {
  cleanup()
  replaceRuntimeEnvironmentRevisions([])
  clearRuntimeCompatibilityCache()
  useAppStore.setState(original)
  vi.unstubAllGlobals()
  expect(spawned.size).toBe(0)
})
function notice(holder = terminal, context: NativeChatOrcaStopView = view) {
  return render(
    <NativeChatOrcaStopContext.Provider value={context}>
      <NativeChatNoticeRow
        block={{ ...block, heldByTerminal: holder }}
        agentName="Codex"
        messageId="notice"
      />
    </NativeChatOrcaStopContext.Provider>
  )
}
it('names and reveals only the verified original; a replacement immediately restores the generic notice', async () => {
  expect(resolveHeldTerminalTarget(useAppStore.getState(), terminal, 'runtime:other')).toBeNull()
  notice()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeDefined())
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
  await waitFor(() => expect(mocks.reveal).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: 'Close terminal' })).toBeDefined()
  expect(screen.getByText(/Codex is already running this conversation in/)).toBeDefined()
  act(() => {
    for (const fn of spawned) {
      fn({ id: 'pty', incarnationId: 'new-life' })
    }
  })
  expect(screen.getByText('Unnamed fallback')).toBeDefined()
  expect(screen.queryByRole('button')).toBeNull()
})
it.each([10, 100])(
  'does no target discovery on %s unrelated publications, updates relevant titles and releases subscriptions',
  async (count) => {
    const tabs = useAppStore.getState().tabsByWorktree.w
    const find = vi.spyOn(tabs, 'find')
    const mounted = notice()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeDefined())
    find.mockClear()
    mocks.capture.mockClear()
    act(() => {
      for (let i = 0; i < count; i++) {
        useAppStore.setState({
          terminalLayoutsByTabId: {
            ...useAppStore.getState().terminalLayoutsByTabId,
            unrelated: { root: null, activeLeafId: null, expandedLeafId: null }
          }
        })
      }
    })
    expect(find).not.toHaveBeenCalled()
    expect(mocks.capture).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        tabsByWorktree: { w: tabs.map((tab) => ({ ...tab, customTitle: 'Renamed' })) }
      })
    )
    await waitFor(() => expect(screen.getByRole('button', { name: 'Renamed' })).toBeDefined())
    mounted.unmount()
    expect(spawned.size).toBe(0)
  }
)
it('keeps legacy metadata generic without a host lookup', () => {
  notice({ ...terminal, incarnationId: '' })
  expect(screen.getByText('Unnamed fallback')).toBeDefined()
  expect(mocks.capture).not.toHaveBeenCalled()
})

it('keeps the single Close attempt busy after holder removal until completion', async () => {
  const closed = Promise.withResolvers<boolean>()
  const retry = vi.fn()
  mocks.close.mockReturnValueOnce(closed.promise)
  function LaunchNotice() {
    const heldTerminal = useHeldTerminalNotice(terminal, 'local', 'Codex')
    return (
      <NativeChatComposerNotices
        notices={structuredSessionNotices({
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
        })}
      />
    )
  }
  render(<LaunchNotice />)
  const button = await screen.findByRole('button', { name: 'Close terminal' })
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  fireEvent.click(button)
  fireEvent.click(button)
  expect(mocks.close).toHaveBeenCalledOnce()
  expect(button).toHaveProperty('disabled', true)
  act(() => useAppStore.setState({ tabsByWorktree: { w: [] } }))
  expect(screen.getByRole('button', { name: 'Close terminal' })).toHaveProperty('disabled', true)
  await act(async () => closed.resolve(true))
})

it.each([undefined, false, 'true'])(
  'retains verified naming/link with unsupported consent %s and withholds only Close',
  async (support) => {
    mocks.capture.mockResolvedValue({ incarnationId: 'life', supportsPinCloseConsent: support })
    notice()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeDefined())
    expect(screen.queryByRole('button', { name: 'Close terminal' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    await waitFor(() => expect(mocks.reveal).toHaveBeenCalledOnce())
    expect(mocks.close).not.toHaveBeenCalled()
  }
)

it.each(['original', 'mirror-replaced', 'paired-producer'] as const)(
  'joins paired original refusal to verified naming/link/Close: %s',
  async (outcome) => {
    const actual = await vi.importActual<typeof CloseHoldingTerminalModule>(
      './close-holding-terminal'
    )
    mocks.capture.mockImplementation(actual.captureHeldTerminal)
    const environmentId = '8612d81e-3491-4816-9aee-88352de753be'
    const specimen = outcome === 'paired-producer' ? pairedWriterFixture : null
    const worktreeId =
      specimen?.worktreeId ??
      'cdb257c7-b8b4-4a66-bc78-49002dbef0ae::C:/Users/neil/orca/workspaces/orca/qa-pr-33721-qg/qa-runtime/fixture-folder'
    const tabId = specimen?.tabId ?? '36f930a4-86c0-4fe2-b956-e67ceda7193b'
    const mirrorId = `web-terminal-${tabId}`
    const leafId = specimen?.leafId ?? '866c3ff1-fc61-4e27-b9c3-0064fdf1a26c'
    const incarnationId = specimen?.incarnationId ?? '33e20019-451d-4211-8844-fc2c45793fff'
    const handle = specimen?.handle ?? 'term_75a94bdc-111d-4797-a524-16399980eccc'
    const ptyId = `remote:${environmentId}@@${handle}`
    const title = 'Reply with T2530-HOST-CODEX'
    const row = {
      ...useAppStore.getState().tabsByWorktree.w[0],
      id: mirrorId,
      worktreeId,
      ptyId,
      title,
      customTitle: null,
      createdAt: 1793020933223
    }
    const identity = {
      worktreeId,
      tabId,
      leafId,
      createdAt: 1793019974077,
      generation: 0,
      hasLeaf: true,
      ptyId: specimen?.ptyId ?? `${worktreeId}@@7ad4d16e`,
      incarnationId
    }
    const resolved: RuntimeTerminalResolvePane = {
      handle,
      tabId,
      leafId,
      worktreeId,
      ptyId: identity.ptyId,
      incarnationId,
      executionHostId: 'local',
      connected: true,
      supportsPinCloseConsent: true,
      presentation: { identity, holders: [{ hostId: 'local', identity }] }
    }
    const holder = specimen
      ? pairedWriterHoldingTerminal
      : { worktreeId, paneKey: `${tabId}:${leafId}`, incarnationId }
    const layout = {
      root: { type: 'leaf' as const, leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      ptyIdsByLeafId: { [leafId]: ptyId }
    }
    replaceRuntimeEnvironmentRevisions([{ id: environmentId, createdAt: 1 }])
    markRuntimeEnvironmentCompatible(environmentId)
    useAppStore.setState({
      tabsByWorktree: { [worktreeId]: [row] },
      terminalLayoutsByTabId: specimen ? {} : { [mirrorId]: layout }
    })
    useAppStore.getState().createUnifiedTab(worktreeId, 'terminal', {
      entityId: mirrorId,
      executionHostId: `runtime:${environmentId}`
    })
    const rpc = vi.fn(async () => {
      if (outcome === 'mirror-replaced') {
        useAppStore.setState({
          tabsByWorktree: {
            [worktreeId]: [{ ...row, createdAt: row.createdAt + 1 }]
          }
        })
      }
      return { ok: true, result: { terminal: resolved } }
    })
    Object.assign(window.api, { runtimeEnvironments: { call: rpc } })
    if (specimen) {
      expect(
        resolveHeldTerminalTarget(useAppStore.getState(), holder, `runtime:${environmentId}`)
      ).toBeNull()
    }
    await act(async () => {
      notice(holder, { ...view, heldTerminal: { executionHostId: `runtime:${environmentId}` } })
    })
    if (specimen) {
      expect(mocks.capture).not.toHaveBeenCalled()
      await act(async () =>
        useAppStore.setState({ terminalLayoutsByTabId: { [mirrorId]: layout } })
      )
    }
    const target = resolveHeldTerminalTarget(
      useAppStore.getState(),
      holder,
      `runtime:${environmentId}`
    )
    expect(target).not.toBeNull()
    const captured = await mocks.capture.mock.results[0].value
    expect(rpc).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: environmentId,
        expectedEnvironmentPairingRevision: 1,
        method: 'terminal.resolvePane',
        params: { worktreeId, paneKey: holder.paneKey }
      })
    )
    if (outcome !== 'mirror-replaced') {
      expect(row.createdAt).not.toBe(identity.createdAt)
      expect(
        captured,
        'recorded mirror/host timestamps differ; matching host handle/incarnation must still verify'
      ).toMatchObject({
        handle,
        incarnationId,
        supportsPinCloseConsent: true
      })
      const link = screen.getByRole('button', { name: title })
      expect(screen.getByRole('button', { name: 'Close terminal' })).toBeDefined()
      fireEvent.click(link)
      await waitFor(() => expect(mocks.reveal).toHaveBeenCalledWith(target))
    } else {
      expect(captured).toBeNull()
      expect(screen.getByText('Unnamed fallback')).toBeDefined()
      expect(screen.queryByRole('button')).toBeNull()
    }
  }
)
