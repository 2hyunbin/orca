import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalPaneResumeOutcome } from '@/store/terminals/terminal-state'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import type { showMainPaneResumeOutcome as ShowOutcome } from './main-pane-resume-banner'

type Outcomes = Record<string, TerminalPaneResumeOutcome>

const store = vi.hoisted(() => {
  let state: { terminalPaneResumeOutcomesByPaneKey: Outcomes } = {
    terminalPaneResumeOutcomesByPaneKey: {}
  }
  const listeners = new Set<(next: typeof state) => void>()
  return {
    getState: () => state,
    subscribe: (listener: (next: typeof state) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    publish: (outcomes: Outcomes) => {
      state = { terminalPaneResumeOutcomesByPaneKey: outcomes }
      for (const listener of listeners) {
        listener(state)
      }
    },
    listenerCount: () => listeners.size
  }
})

vi.mock('@/store', () => ({ useAppStore: store }))
vi.mock('./main-starts-pane', () => ({ mainStartsPane: () => true }))

const PANE_KEY = 'tab-1:leaf-1'

function attachedView() {
  const view = {
    cacheKey: PANE_KEY,
    disposed: false,
    waitTeardowns: new Array<() => void>(),
    showSessionRestoredBanner: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the banner reads only these session fields; mainStartsPane is mocked.
  return { view, session: view as unknown as ConnectPanePtySession }
}

describe("the window's banner for main's start of a pane", () => {
  let showMainPaneResumeOutcome: typeof ShowOutcome

  beforeEach(async () => {
    vi.resetModules()
    store.publish({})
    ;({ showMainPaneResumeOutcome } = await import('./main-pane-resume-banner'))
  })

  it('shows the outcome of the terminal the view attached, once per start', () => {
    store.publish({ [PANE_KEY]: { ptyId: 'pty-1', ptyGeneration: 1, outcome: 'restored' } })
    const first = attachedView()
    showMainPaneResumeOutcome(first.session, 'pty-1')
    expect(first.view.showSessionRestoredBanner).toHaveBeenCalledExactlyOnceWith('restored')

    // A remounted view attaching the same start says nothing again.
    const remounted = attachedView()
    showMainPaneResumeOutcome(remounted.session, 'pty-1')
    expect(remounted.view.showSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('shows nothing for an outcome naming another terminal', () => {
    store.publish({ [PANE_KEY]: { ptyId: 'pty-old', ptyGeneration: 1, outcome: 'restored' } })
    const { view, session } = attachedView()
    showMainPaneResumeOutcome(session, 'pty-1')
    store.publish({
      [PANE_KEY]: { ptyId: 'pty-old', ptyGeneration: 2, outcome: 'resume-unavailable' }
    })
    expect(view.showSessionRestoredBanner).not.toHaveBeenCalled()
  })

  it('shows an outcome that arrives after the attach, then stops watching', () => {
    const { view, session } = attachedView()
    showMainPaneResumeOutcome(session, 'pty-1')
    expect(view.showSessionRestoredBanner).not.toHaveBeenCalled()

    store.publish({
      [PANE_KEY]: { ptyId: 'pty-1', ptyGeneration: 1, outcome: 'resume-unavailable' }
    })
    expect(view.showSessionRestoredBanner).toHaveBeenCalledExactlyOnceWith('resume-unavailable')
    expect(store.listenerCount()).toBe(0)
    expect(view.waitTeardowns).toEqual([])
  })
})
