// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { NativeChatSessionGate } from './NativeChatSessionGate'
import { useNativeChatDraft } from './use-native-chat-draft'
import { clearNativeChatDraftCacheForTests } from './native-chat-draft-cache'
import {
  NativeChatMarkdownImageOwnerContext,
  NativeChatMarkdownImageOwnerProvider
} from './native-chat-markdown-image-owner'
import { useAppStore } from '@/store'
import {
  repoFixture,
  terminalTabFixture,
  worktreeFixture
} from './native-chat-workspace-test-fixtures'

function entry(overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>) {
  return {
    state: 'working' as const,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    ...overrides
  }
}

function renderResolution(
  props: Omit<React.ComponentProps<typeof NativeChatSessionGate>, 'children'>
): void {
  render(
    <NativeChatSessionGate {...props}>
      {(resolution) => (
        <div data-testid="native-chat-resolution">
          {resolution.agent}:{resolution.sessionId ?? 'no-session'}:{resolution.paneKey}
        </div>
      )}
    </NativeChatSessionGate>
  )
}

const notComposing = (): boolean => false

function DraftProbe({ paneKey, sessionId }: { paneKey: string; sessionId: string | null }) {
  const { draft, setDraft } = useNativeChatDraft(paneKey, notComposing)
  return (
    <label>
      Session {sessionId ?? 'none'}
      <input
        aria-label="Message draft"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
    </label>
  )
}

describe('NativeChatSessionGate', () => {
  afterEach(() => {
    cleanup()
    clearNativeChatDraftCacheForTests()
  })

  it('keeps the startup pane usable without inventing a chat file session identity', () => {
    useAppStore.setState({
      ...useAppStore.getInitialState(),
      repos: [repoFixture()],
      worktreesByRepo: { repo: [worktreeFixture('wt-1', '/repo', { hostId: 'local' })] },
      tabsByWorktree: { 'wt-1': [terminalTabFixture('tab-1', 'wt-1')] }
    })
    const pane = (sessionId: string | null) => (
      <NativeChatMarkdownImageOwnerProvider tabId="tab-1" sessionId={sessionId} isVisible>
        <NativeChatMarkdownImageOwnerContext.Consumer>
          {(owner) => (
            <output>
              {owner?.runtimeContext?.nativeChatContext?.sessionId ?? 'no-session'}:
              {owner?.fileLinkContext?.chatSessionId ?? 'no-session'}
            </output>
          )}
        </NativeChatMarkdownImageOwnerContext.Consumer>
        <DraftProbe paneKey="tab-1:leaf-1" sessionId={sessionId} />
      </NativeChatMarkdownImageOwnerProvider>
    )
    const view = render(pane(null))
    expect(screen.getByRole('status')).toHaveTextContent('no-session:no-session')
    const composer = screen.getByRole('textbox', { name: 'Message draft' })
    fireEvent.change(composer, { target: { value: 'startup draft' } })
    view.rerender(pane('known-session'))
    expect(screen.getByRole('status')).toHaveTextContent('known-session:known-session')
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toBe(composer)
    expect(composer).toHaveValue('startup draft')
  })

  it('preserves the open composer, session, and draft through disconnect and reconnect', () => {
    const paneKey = 'tab-1:leaf-1'
    const connectedEntry = entry({
      paneKey,
      agentType: 'codex',
      providerSession: { key: 'session_id', id: 'codex-session' }
    })
    const renderGate = (
      agentStatusEntry?: AgentStatusEntry,
      launchAgent: 'codex' | null = null
    ) => (
      <NativeChatSessionGate
        paneKey={paneKey}
        launchAgent={launchAgent}
        resolvedAgent={null}
        agentStatusEntry={agentStatusEntry}
        ptyId={agentStatusEntry ? 'pty-connected' : null}
      >
        {(resolution) => (
          <DraftProbe paneKey={resolution.paneKey} sessionId={resolution.sessionId} />
        )}
      </NativeChatSessionGate>
    )
    const view = render(renderGate(connectedEntry))
    const composer = screen.getByRole('textbox', { name: 'Message draft' })

    fireEvent.change(composer, { target: { value: 'keep this unsent message' } })
    view.rerender(renderGate(undefined, 'codex'))

    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )

    view.rerender(renderGate())

    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )

    view.rerender(renderGate(connectedEntry))
    expect(screen.getByText('Session codex-session')).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Message draft' })).toHaveValue(
      'keep this unsent message'
    )
  })

  it('does not open native chat from an unsupported title fallback', () => {
    renderResolution({
      paneKey: 'tab-1:leaf-1',
      launchAgent: null,
      resolvedAgent: 'gemini',
      ptyId: 'pty-1'
    })

    expect(screen.getByText('No conversation here')).toBeInTheDocument()
    expect(screen.queryByTestId('native-chat-resolution')).not.toBeInTheDocument()
  })
})
