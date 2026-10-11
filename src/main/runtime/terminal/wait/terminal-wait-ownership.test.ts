import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalAgentStatus } from '../../../../shared/runtime-types'
import type { TuiIdleEvidenceSource } from '../../tui-idle-evidence-source'
import { makeTuiIdleLeaf, makeTuiIdlePty } from '../../tui-idle-wait-test-harness'
import { TerminalDeliveryReadiness } from '../input/terminal-delivery-readiness'
import { TerminalInteractiveWait } from './terminal-interactive-wait'
import { TerminalWaitBlockedChecks } from './terminal-wait-blocked-checks'

const evidence: TuiIdleEvidenceSource = {
  quiescenceMs: 3000,
  getTabTitle: () => null,
  getAdoptedPtyIdleStatus: () => null,
  getPaneAgent: () => null,
  getFirstPartyAgentStatus: () => null,
  readScreenLines: () => null
}

function pendingStatus() {
  let finish!: (status: RuntimeTerminalAgentStatus) => void
  const status = new Promise<RuntimeTerminalAgentStatus>((resolve) => {
    finish = resolve
  })
  return { status, finish }
}

function interactiveWait(getStatus: (handle: string) => Promise<RuntimeTerminalAgentStatus>) {
  return new TerminalInteractiveWait({
    getTerminalAgentStatusPtyId: () => 'pty-1',
    getTerminalWaitPermissionInputs: () => ({
      terminal: {
        waitText: '',
        waitBlockedAt: null,
        title: null,
        titleStatus: null,
        titleStatusIsLive: false
      },
      lifecycle: null
    }),
    getFreshExplicitAgentStatusForHandle: () => ({ status: 'permission', updatedAt: 42 }),
    resolveAuthoritativeTerminalWaitPermission: () => null,
    getTerminalAgentStatus: getStatus
  })
}

describe('terminal wait ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares permission probes per PTY and releases the completed probe', async () => {
    const pending = pendingStatus()
    const getStatus = vi.fn(() => pending.status)
    const wait = interactiveWait(getStatus)
    const first = wait.getTerminalInteractiveWait('handle-1')
    const second = wait.getTerminalInteractiveWait('handle-2')
    expect(getStatus).toHaveBeenCalledOnce()
    pending.finish({ handle: 'handle-1', isRunningAgent: true, status: 'permission' })
    expect(await first).toEqual({ source: 'hook', since: 42 })
    expect(await second).toEqual({ source: 'hook', since: 42 })
    await wait.getTerminalInteractiveWait('handle-3')
    expect(getStatus).toHaveBeenCalledTimes(2)
  })

  it('keeps a timed-out permission probe in flight until its host responds', async () => {
    const pending = pendingStatus()
    const getStatus = vi.fn(() => pending.status)
    const wait = interactiveWait(getStatus)
    const first = wait.getTerminalInteractiveWait('handle-1')
    await vi.advanceTimersByTimeAsync(2000)
    expect(await first).toBeUndefined()
    const second = wait.getTerminalInteractiveWait('handle-2')
    expect(getStatus).toHaveBeenCalledOnce()
    pending.finish({ handle: 'handle-1', isRunningAgent: true, status: 'permission' })
    expect(await second).toEqual({ source: 'hook', since: 42 })
  })

  it('isolates permission probes between runtime owners with the same PTY id', async () => {
    const pending = pendingStatus()
    const getStatus = vi.fn(() => pending.status)
    const first = interactiveWait(getStatus).getTerminalInteractiveWait('handle-1')
    const second = interactiveWait(getStatus).getTerminalInteractiveWait('handle-1')
    expect(getStatus).toHaveBeenCalledTimes(2)
    pending.finish({ handle: 'handle-1', isRunningAgent: false, status: null })
    expect(await first).toBeNull()
    expect(await second).toBeNull()
  })

  it('rechecks current leaf evidence before delivery and coalesces repeated refusals', async () => {
    let leaf = makeTuiIdleLeaf({ lastOutputAt: Date.now(), lastAgentStatus: 'working' })
    const deliver = vi.fn()
    const readiness = new TerminalDeliveryReadiness(
      {
        getLeafKey: (tabId, leafId) => `${tabId}::${leafId}`,
        getLeaf: () => leaf,
        deliverPendingMessagesForLeaf: deliver
      },
      evidence
    )
    expect(readiness.checkDeliverySettledAndArmRecheck(leaf)).toBe(false)
    expect(readiness.checkDeliverySettledAndArmRecheck(leaf)).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    leaf = makeTuiIdleLeaf({ lastOutputAt: Date.now(), lastAgentStatus: 'idle' })
    await vi.advanceTimersByTimeAsync(3050)
    expect(deliver).toHaveBeenCalledOnce()
    expect(deliver).toHaveBeenCalledWith(leaf)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels only the delivery recheck belonging to its owner', async () => {
    const leaf = makeTuiIdleLeaf({ lastOutputAt: Date.now(), lastAgentStatus: 'working' })
    const host = {
      getLeafKey: () => 'leaf-1',
      getLeaf: () => leaf,
      deliverPendingMessagesForLeaf: vi.fn()
    }
    const first = new TerminalDeliveryReadiness(host, evidence)
    const second = new TerminalDeliveryReadiness(host, evidence)
    first.checkDeliverySettledAndArmRecheck(leaf)
    second.checkDeliverySettledAndArmRecheck(leaf)
    expect(vi.getTimerCount()).toBe(2)
    first.clearDeliveryRecheck('leaf-1')
    expect(vi.getTimerCount()).toBe(1)
    second.clearDeliveryRecheck('leaf-1')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears a pending blocked scan without cancelling another owner scan', async () => {
    const pty = makeTuiIdlePty({ waitBlockedAt: null })
    const getPty = vi.fn(() => pty)
    const host = { getPty, recordAgentPromptPermissionObservation: () => {} }
    const first = new TerminalWaitBlockedChecks(host)
    const second = new TerminalWaitBlockedChecks(host)
    first.scheduleWaitBlockedCheck('pty-1', 'output', 10_000)
    second.scheduleWaitBlockedCheck('pty-1', 'output', 10_000)
    first.scheduleWaitBlockedCheck('pty-1', 'more', 10_001)
    second.scheduleWaitBlockedCheck('pty-1', 'more', 10_001)
    expect(vi.getTimerCount()).toBe(2)
    first.clearWaitBlockedCheckState('pty-1')
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(50)
    expect(getPty).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
})
