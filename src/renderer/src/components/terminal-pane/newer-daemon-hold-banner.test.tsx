// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import { NewerDaemonHoldBanner } from './NewerDaemonHoldBanner'
import {
  holdPaneForNewerDaemon,
  reopenHeldTerminals,
  resetNewerDaemonHoldStateForTests,
  type HeldPaneReopenOutcome
} from './newer-daemon-hold-state'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)
const TITLE = 'This terminal was opened in a newer version of Orca'
const BODY = 'Reopen it here to keep working. Your agent session will resume.'
const FAILED_TITLE = "Couldn't reopen this terminal"

let paneElement: HTMLDivElement
let root: Root
let reopenNewerDaemonTerminals: ReturnType<typeof vi.fn<() => Promise<NewerDaemonReopenResult>>>
let announceRelease: () => void = () => {}

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

function release(outcome: HeldPaneReopenOutcome) {
  return vi.fn(() => Promise.resolve(outcome))
}

async function renderBanner(): Promise<void> {
  await act(async () => {
    root.render(<NewerDaemonHoldBanner tabId={TAB_ID} leafId={LEAF_ID} />)
  })
}

function button(label: string): HTMLButtonElement {
  const match = Array.from(paneElement.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!match) {
    throw new Error(`missing ${label} button`)
  }
  return match
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.spyOn(toast, 'success').mockImplementation(() => 'toast')
  resetNewerDaemonHoldStateForTests()
  paneElement = document.createElement('div')
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  reopenNewerDaemonTerminals = vi.fn(() => Promise.resolve({ reopened: true }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      pty: {
        reopenNewerDaemonTerminals,
        onNewerDaemonReleased: (callback: () => void) => {
          announceRelease = callback
          return () => {}
        }
      }
    }
  })
})

afterEach(() => {
  act(() => root.unmount())
  paneElement.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  resetNewerDaemonHoldStateForTests()
})

describe('NewerDaemonHoldBanner', () => {
  it('renders nothing for a pane that is not held', async () => {
    await renderBanner()
    expect(paneElement.textContent).toBe('')
  })

  it('promises a resume only for a pane with a resumable agent session', async () => {
    const forget = holdPaneForNewerDaemon(PANE_KEY, {
      resumable: true,
      release: release({ reopened: true, agentResumed: true })
    })
    await renderBanner()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).toContain(BODY)
    expect(paneElement.textContent).not.toContain('Dismiss')
    act(() => forget())
    holdPaneForNewerDaemon(PANE_KEY, {
      resumable: false,
      release: release({ reopened: true, agentResumed: false })
    })
    await renderBanner()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).not.toContain(BODY)
  })

  it('disables the button while reopening and releases every held pane after the stop', async () => {
    let finishStop!: (result: NewerDaemonReopenResult) => void
    reopenNewerDaemonTerminals.mockReturnValue(
      new Promise((resolve) => {
        finishStop = resolve
      })
    )
    const releaseThis = release({ reopened: true, agentResumed: true })
    const releaseOther = release({ reopened: true, agentResumed: false })
    holdPaneForNewerDaemon(PANE_KEY, { resumable: true, release: releaseThis })
    holdPaneForNewerDaemon('other-tab:leaf', { resumable: false, release: releaseOther })
    await renderBanner()
    await act(async () => button('Reopen terminal').click())
    expect(button('Reopening…').disabled).toBe(true)
    expect(releaseThis).not.toHaveBeenCalled()
    await act(async () => finishStop({ reopened: true }))
    expect(releaseThis).toHaveBeenCalledTimes(1)
    expect(releaseOther).toHaveBeenCalledTimes(1)
    expect(paneElement.textContent).toBe('')
    expect(toast.success).toHaveBeenCalledWith('Reopened 2 terminals', {
      description: '1 agent session resumed.'
    })
  })

  it('reopens nothing and offers a retry when the stop is not confirmed', async () => {
    reopenNewerDaemonTerminals.mockResolvedValue({ reopened: false })
    const releasePane = release({ reopened: true, agentResumed: true })
    holdPaneForNewerDaemon(PANE_KEY, { resumable: true, release: releasePane })
    await renderBanner()
    await act(async () => button('Reopen terminal').click())
    expect(paneElement.textContent).toContain(FAILED_TITLE)
    expect(paneElement.textContent).not.toContain(BODY)
    expect(button('Try again').disabled).toBe(false)
    expect(releasePane).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('hold phase and release', () => {
  it('shows a pane held after a failed attempt as held, not failed', async () => {
    reopenNewerDaemonTerminals.mockResolvedValue({ reopened: false })
    holdPaneForNewerDaemon('other-tab:leaf', {
      resumable: false,
      release: release({ reopened: true, agentResumed: false })
    })
    await reopenHeldTerminals()
    holdPaneForNewerDaemon(PANE_KEY, {
      resumable: true,
      release: release({ reopened: true, agentResumed: true })
    })
    await renderBanner()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).toContain(BODY)
    expect(paneElement.textContent).not.toContain(FAILED_TITLE)
  })

  it('releases held panes when main announces a stop another surface confirmed, without a toast', async () => {
    const releasePane = release({ reopened: true, agentResumed: true })
    holdPaneForNewerDaemon(PANE_KEY, { resumable: true, release: releasePane })
    await renderBanner()
    await act(async () => announceRelease())
    expect(releasePane).toHaveBeenCalledOnce()
    expect(paneElement.textContent).toBe('')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('releases once, with one toast, when this window clicked and main also announces', async () => {
    const releasePane = release({ reopened: true, agentResumed: false })
    reopenNewerDaemonTerminals.mockImplementation(async () => {
      announceRelease()
      return { reopened: true }
    })
    holdPaneForNewerDaemon(PANE_KEY, { resumable: false, release: releasePane })
    await reopenHeldTerminals()
    expect(releasePane).toHaveBeenCalledOnce()
    expect(toast.success).toHaveBeenCalledOnce()
  })
})

describe('reopen toast', () => {
  it.each([
    [[{ reopened: true, agentResumed: false }], 'Reopened 1 terminal', undefined],
    [
      [
        { reopened: true, agentResumed: true },
        { reopened: true, agentResumed: true },
        { reopened: false, agentResumed: false }
      ],
      'Reopened 2 terminals',
      { description: '2 agent sessions resumed.' }
    ]
  ])('counts only what reopened', async (outcomes, title, options) => {
    outcomes.forEach((outcome, index) =>
      holdPaneForNewerDaemon(`pane-${index}`, { resumable: true, release: release(outcome) })
    )
    await reopenHeldTerminals()
    expect(toast.success).toHaveBeenCalledWith(title, options)
  })

  it('shows no toast when nothing reopened', async () => {
    holdPaneForNewerDaemon(PANE_KEY, {
      resumable: true,
      release: release({ reopened: false, agentResumed: false })
    })
    await reopenHeldTerminals()
    expect(toast.success).not.toHaveBeenCalled()
  })
})
