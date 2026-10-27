import { createElement, type ContextType, type PropsWithChildren } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { MobileNativeChatNoticeRow, MobileHeldTerminalContext } from './MobileNativeChatNoticeRow'
import {
  pairedWriterFixture,
  pairedWriterHoldingTerminal
} from '../../../src/shared/__fixtures__/captured-pinned-terminal-close.test-fixture'
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  Text: ({ children }: PropsWithChildren) => createElement('span', null, children),
  View: ({ children }: PropsWithChildren) => createElement('div', null, children),
  StyleSheet: { create: (v: unknown) => v, hairlineWidth: 1 }
}))
vi.mock('lucide-react-native', () => ({
  AlertCircle: 'AlertCircle',
  AlertTriangle: 'AlertTriangle',
  Info: 'Info'
}))
vi.mock('../components/MobileMarkdown', () => ({ MobileMarkdown: 'Markdown' }))
const { leafId, worktreeId, tabId, incarnationId } = pairedWriterFixture
const heldScreen = {
  worktreeId,
  agent: 'codex',
  tabs: [
    {
      type: 'terminal',
      id: 'pane',
      parentTabId: tabId,
      leafId,
      title: 'Review',
      terminal: 'pty',
      incarnationId,
      isActive: false
    }
  ]
} satisfies NonNullable<ContextType<typeof MobileHeldTerminalContext>>
const futureScreen = { ...heldScreen, agent: 'future-cli' }
const missingScreen = { ...heldScreen, tabs: [] }
it.each(['named', 'workspace', 'missing', 'replaced', 'legacy', 'unknown-agent'] as const)(
  'renders a plain title only for the matching screen: %s',
  (kind) => {
    const text = renderToStaticMarkup(
      <MobileHeldTerminalContext.Provider
        value={
          kind === 'missing' ? missingScreen : kind === 'unknown-agent' ? futureScreen : heldScreen
        }
      >
        <MobileNativeChatNoticeRow
          fontScale={1}
          blocks={[
            {
              type: 'text',
              tone: 'error',
              text: 'Unnamed fallback',
              failure: { kind: 'conversationOpenInTerminal' },
              heldByTerminal: {
                ...pairedWriterHoldingTerminal,
                worktreeId: kind === 'workspace' ? 'other' : worktreeId,
                incarnationId:
                  kind === 'legacy' ? undefined : kind === 'replaced' ? 'old' : incarnationId
              }
            }
          ]}
        />
      </MobileHeldTerminalContext.Provider>
    )
    expect(text).toContain(
      kind === 'named' || kind === 'unknown-agent'
        ? `${kind === 'named' ? 'Codex' : 'future-cli'} is already running this conversation in Review.`
        : 'Unnamed fallback'
    )
    expect(text).not.toMatch(/<(a|button)\b/)
  }
)
