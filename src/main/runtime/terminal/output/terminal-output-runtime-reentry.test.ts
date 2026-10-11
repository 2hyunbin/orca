import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'

describe('terminal output runtime re-entry', () => {
  it('uses a later title handler replacement with the runtime receiver', () => {
    const runtime = new OrcaRuntimeService()
    const ptyId = 'pty-reentry'
    runtime['getOrCreatePtyTitleTrackerEntry'](ptyId)
    const original = runtime['applyTrackedPtyTitle']
    const receivers: OrcaRuntimeService[] = []
    const titles: string[] = []
    runtime['applyTrackedPtyTitle'] = function (
      this: OrcaRuntimeService,
      ...args: Parameters<typeof original>
    ): boolean {
      receivers.push(this)
      titles.push(args[1])
      return false
    }
    try {
      runtime.ingestSyntheticTitleFrame(ptyId, '\x1b]0;Codex working\x07')
      expect(receivers).toEqual([runtime])
      expect(titles).toEqual(['Codex working'])
    } finally {
      runtime['applyTrackedPtyTitle'] = original
      runtime.onPtyExit(ptyId, 0)
    }
  })

  it('calls the current injected listener with the runtime receiver', () => {
    const receivers: OrcaRuntimeService[] = []
    const calls: string[] = []
    const runtime = new OrcaRuntimeService(null, undefined, {
      onTerminalSideEffects: function (this: OrcaRuntimeService) {
        receivers.push(this)
        calls.push('initial')
      }
    })
    runtime['setTerminalSideEffectConsumerAvailable'](true)
    runtime['emitTerminalSideEffectBatch']('pty-reentry', [{ kind: 'bell' }])
    Object.defineProperty(runtime, 'onTerminalSideEffects', {
      value: function (this: OrcaRuntimeService) {
        receivers.push(this)
        calls.push('replacement')
      }
    })
    runtime['emitTerminalSideEffectBatch']('pty-reentry', [{ kind: 'bell' }])
    expect(receivers).toEqual([runtime, runtime])
    expect(calls).toEqual(['initial', 'replacement'])
  })

  it('keeps optional reconciliation lazy after its callback is removed', () => {
    const receivers: OrcaRuntimeService[] = []
    const runtime = new OrcaRuntimeService(null, undefined, {
      reconcileAgentStatusForEndedProcess: function (this: OrcaRuntimeService) {
        receivers.push(this)
      }
    })
    const collectPaneKeys = vi.fn(() => new Set<string>())
    runtime['collectAgentStatusPaneKeysForPty'] = collectPaneKeys
    runtime['resetTrackedTerminalStateForProviderGeneration']('pty-reentry')
    expect(receivers).toEqual([runtime])
    expect(collectPaneKeys).toHaveBeenCalledOnce()
    Object.defineProperty(runtime, 'reconcileAgentStatusForEndedProcessFn', { value: null })
    runtime['resetTrackedTerminalStateForProviderGeneration']('pty-reentry')
    expect(collectPaneKeys).toHaveBeenCalledOnce()
  })
})
