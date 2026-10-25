import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'

const flow = vi.hoisted(() => ({
  begin: vi.fn(() => 'staged-1'),
  continue: vi.fn(() => true),
  run: vi.fn(() => 'run-1')
}))
const store = vi.hoisted(() => {
  const pendingWorktreeCreations: Record<string, unknown> = {}
  return { pendingWorktreeCreations, removePendingWorktreeCreation: vi.fn() }
})
vi.mock('@/lib/worktree-creation-flow', () => ({
  beginBackgroundWorktreePreparation: flow.begin,
  continueBackgroundWorktreeCreation: flow.continue,
  runBackgroundWorktreeCreation: flow.run
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))

import { scheduleComposerCreateHandoff } from './composer-create-handoff'

function makeRequest(name: string): WorktreeCreationRequest {
  return {
    repoId: 'repo-1',
    name,
    setupDecision: 'inherit',
    agent: null,
    pendingFirstAgentMessageRename: false,
    note: '',
    startupPlan: null,
    quickPrompt: '',
    quickTelemetry: null
  }
}
const stagingRequest = makeRequest('staged')
const finalRequest = makeRequest('final')

describe('scheduleComposerCreateHandoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    store.pendingWorktreeCreations = {}
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('starts directly without staging or closing when preflight is fast', () => {
    const onHandOff = vi.fn()
    const handoff = scheduleComposerCreateHandoff({
      stagingRequest,
      onHandOff,
      isCancelled: () => false
    })
    handoff.start(finalRequest)
    vi.runAllTimers()

    expect(flow.run).toHaveBeenCalledWith(finalRequest)
    expect(flow.begin).not.toHaveBeenCalled()
    expect(onHandOff).not.toHaveBeenCalled()
    expect(handoff.isHandedOff()).toBe(false)
    expect(handoff.dispose()).toBe(false)
  })

  it('closes the composer onto a staged row when preflight stalls, then continues it', () => {
    const onHandOff = vi.fn()
    const handoff = scheduleComposerCreateHandoff({
      stagingRequest,
      onHandOff,
      isCancelled: () => false
    })
    vi.runAllTimers()

    expect(flow.begin).toHaveBeenCalledWith(stagingRequest)
    expect(onHandOff).toHaveBeenCalledTimes(1)
    expect(handoff.isHandedOff()).toBe(true)

    handoff.start(finalRequest)
    expect(flow.continue).toHaveBeenCalledWith('staged-1', finalRequest)
    expect(flow.run).not.toHaveBeenCalled()
    expect(handoff.dispose()).toBe(false)
  })

  it('removes a staged row that preflight never started', () => {
    const handoff = scheduleComposerCreateHandoff({
      stagingRequest,
      onHandOff: vi.fn(),
      isCancelled: () => false
    })
    vi.runAllTimers()
    store.pendingWorktreeCreations = { 'staged-1': {} }

    expect(handoff.dispose()).toBe(true)
    expect(store.removePendingWorktreeCreation).toHaveBeenCalledWith('staged-1')
  })

  it('does not stage or close again after the user dismissed the composer', () => {
    const onHandOff = vi.fn()
    scheduleComposerCreateHandoff({ stagingRequest, onHandOff, isCancelled: () => true })
    vi.runAllTimers()

    expect(flow.begin).not.toHaveBeenCalled()
    expect(onHandOff).not.toHaveBeenCalled()
  })
})
