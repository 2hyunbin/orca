// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppStore } from '@/store'
import { resolveHeldTerminalTarget } from './native-chat-held-terminal'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
const reveal = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reveal-terminal-pane', () => ({ revealTerminalPane: reveal }))
const leaf = '11111111-1111-4111-8111-111111111111'
const original = useAppStore.getState()
const retryFor = vi.fn(() => vi.fn())
const view = {
  hostLabel: null,
  remoteHost: true,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: () => {},
  usageLimitTurnItemId: null,
  continueUsageLimit: () => {},
  heldTerminal: { executionHostId: 'runtime:host' as const, retryFor }
}

afterEach(() => {
  cleanup()
  useAppStore.setState(original)
})
it('names and reveals the refusing pane on its host, falling back when its target is stale', () => {
  const tabId = toWebTerminalSurfaceTabId('terminal')
  useAppStore.setState({
    tabsByWorktree: {
      w: [
        {
          id: tabId,
          worktreeId: 'w',
          title: 'Shell',
          customTitle: 'Review',
          ptyId: null,
          color: null,
          createdAt: 1,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      [tabId]: { root: { type: 'leaf', leafId: leaf }, activeLeafId: leaf, expandedLeafId: null }
    }
  })
  const tab = useAppStore
    .getState()
    .createUnifiedTab('w', 'terminal', { entityId: tabId, executionHostId: 'runtime:host' })
  const terminal = { paneKey: `terminal:${leaf}`, worktreeId: 'w' }
  expect(resolveHeldTerminalTarget(useAppStore.getState(), terminal, 'runtime:other')).toBeNull()
  expect(
    resolveHeldTerminalTarget(
      useAppStore.getState(),
      { ...terminal, worktreeId: 'elsewhere' },
      'runtime:host'
    )
  ).toBeNull()
  const block = {
    type: 'text' as const,
    text: 'Unnamed fallback',
    failure: { kind: 'conversationOpenInTerminal' as const },
    heldByTerminal: terminal
  }
  const mounted = render(
    <NativeChatOrcaStopContext.Provider value={view}>
      <NativeChatNoticeRow block={block} agentName="Codex" messageId="notice" />
    </NativeChatOrcaStopContext.Provider>
  )
  fireEvent.click(screen.getByRole('link', { name: 'Review' }))
  expect(reveal).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      worktreeId: 'w',
      tabId,
      leafId: leaf,
      executionHostId: 'runtime:host'
    })
  )
  expect(screen.getByRole('button', { name: 'Close terminal' })).toBeDefined()
  mounted.unmount()
  useAppStore.getState().closeUnifiedTab(tab.id)
  render(
    <NativeChatOrcaStopContext.Provider value={view}>
      <NativeChatNoticeRow block={block} agentName="Codex" />
    </NativeChatOrcaStopContext.Provider>
  )
  expect(screen.getByText('Unnamed fallback')).toBeDefined()
  expect(screen.queryByRole('link')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})
