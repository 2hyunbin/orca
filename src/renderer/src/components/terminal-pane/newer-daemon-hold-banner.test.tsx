// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { NewerDaemonReopenResult } from '../../../../shared/newer-daemon-hold'
import { NewerDaemonHoldBanner } from './NewerDaemonHoldBanner'
import { holdPaneForNewerDaemon, newerDaemonHoldStore } from './newer-daemon-hold-state'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

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

class ResizeObserverStub {
  observe(): void {}
  disconnect(): void {}
}

function hold(paneKey: string, resumable: boolean): void {
  holdPaneForNewerDaemon(paneKey, {
    resumable,
    release: vi.fn(() => Promise.resolve({ reopened: true, agentResumed: resumable }))
  })
}

async function render(): Promise<void> {
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
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  newerDaemonHoldStore.setState({ panes: {} })
  paneElement = document.createElement('div')
  document.body.appendChild(paneElement)
  root = createRoot(paneElement)
  reopenNewerDaemonTerminals = vi.fn(() => Promise.resolve({ reopened: true }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { pty: { reopenNewerDaemonTerminals } }
  })
})

afterEach(() => {
  act(() => root.unmount())
  paneElement.remove()
  vi.unstubAllGlobals()
})

describe('NewerDaemonHoldBanner', () => {
  it('renders nothing for a pane that is not held', async () => {
    await render()
    expect(paneElement.textContent).toBe('')
  })

  it('promises a resume only for a pane with a resumable agent session', async () => {
    hold(PANE_KEY, true)
    await render()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).toContain(BODY)
    expect(paneElement.textContent).not.toContain('Dismiss')
    hold(PANE_KEY, false)
    await render()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).not.toContain(BODY)
  })

  it('shows Reopening while the stop runs, then nothing once released', async () => {
    let finish!: (result: NewerDaemonReopenResult) => void
    reopenNewerDaemonTerminals.mockReturnValue(new Promise((resolve) => (finish = resolve)))
    hold(PANE_KEY, true)
    await render()
    await act(async () => button('Reopen terminal').click())
    expect(button('Reopening…').disabled).toBe(true)
    await act(async () => finish({ reopened: true }))
    expect(paneElement.textContent).toBe('')
  })

  it('offers Try again after an unconfirmed stop, but not to a pane held afterwards', async () => {
    reopenNewerDaemonTerminals.mockResolvedValue({ reopened: false })
    hold(PANE_KEY, true)
    await render()
    await act(async () => button('Reopen terminal').click())
    expect(paneElement.textContent).toContain(FAILED_TITLE)
    expect(paneElement.textContent).not.toContain(BODY)
    expect(button('Try again').disabled).toBe(false)
    hold(PANE_KEY, true)
    await render()
    expect(paneElement.textContent).toContain(TITLE)
    expect(paneElement.textContent).not.toContain(FAILED_TITLE)
  })
})
