import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'

describe('terminal status runtime re-entry', () => {
  it('reads the current hook callback with the runtime receiver and keeps unverifiable evidence', async () => {
    const receivers: boolean[] = []
    const runtime = new OrcaRuntimeService(null, undefined, {
      checkHookAgentPresence: function (this: OrcaRuntimeService) {
        receivers.push(this === runtime)
        return Promise.resolve('unverifiable')
      }
    })
    const collect = vi.fn(() => new Set(['pane-a', 'pane-b']))
    runtime['collectAgentStatusPaneKeysForPty'] = collect
    expect(await runtime['recheckHookAgentPresenceForPty']('pty-status')).toBe('unverifiable')
    Object.defineProperty(runtime, 'checkHookAgentPresenceFn', {
      value: function (this: OrcaRuntimeService) {
        receivers.push(this === runtime)
        return Promise.resolve('live')
      },
      configurable: true
    })
    expect(await runtime['recheckHookAgentPresenceForPty']('pty-status')).toBe('live')
    expect(receivers).toEqual([true, true, true, true])
    Object.defineProperty(runtime, 'checkHookAgentPresenceFn', { value: null })
    expect(await runtime['recheckHookAgentPresenceForPty']('pty-status')).toBeNull()
    expect(collect).toHaveBeenCalledTimes(2)
  })

  it('honors a later permission observation replacement before recording lifecycle state', () => {
    const runtime = new OrcaRuntimeService()
    const observations: boolean[] = []
    runtime['recordAgentPromptPermissionObservation'] = function (this: OrcaRuntimeService) {
      observations.push(this === runtime && !this['agentPromptLifecycleByPtyId'].has('pty-status'))
    }
    runtime['recordAgentPromptLifecycleState']('pty-status', 'permission')
    expect(observations).toEqual([true])
    expect(runtime['agentPromptLifecycleByPtyId'].get('pty-status')?.status).toBe('permission')
    expect(runtime['agentPromptPermissionSequenceByPtyId'].has('pty-status')).toBe(false)
  })

  it('uses the current explicit status lookup and shared retirement floor', () => {
    const runtime = new OrcaRuntimeService()
    const receivers: boolean[] = []
    runtime['getFreshExplicitAgentStatusForHandle'] = function (this: OrcaRuntimeService) {
      receivers.push(this === runtime)
      return { status: 'idle', updatedAt: 10, stateStartedAt: 5 }
    }
    expect(
      runtime['getFreshExplicitAgentStatusForPty']('handle-status', 'pty-status')?.status
    ).toBe('idle')
    runtime['agentPromptExplicitStatusFloorByPtyId'].set('pty-status', 10)
    expect(runtime['getFreshExplicitAgentStatusForPty']('handle-status', 'pty-status')).toBeNull()
    expect(receivers).toEqual([true, true])
  })

  it('ignores a hook exit response after the tracked PTY is replaced', async () => {
    const runtime = new OrcaRuntimeService()
    const ptyId = 'pty-status'
    const original = runtime['recordPtyWorktree'](ptyId, 'workspace-status')
    const response = Promise.withResolvers<'exited'>()
    const receivers: boolean[] = []
    runtime['recheckHookAgentPresenceForPty'] = function (this: OrcaRuntimeService) {
      receivers.push(this === runtime)
      return response.promise
    }
    const record = vi.fn()
    runtime['recordTerminalSideEffectFact'] = record
    runtime['confirmPtyAgentExit'](ptyId)
    runtime['ptysById'].set(ptyId, { ...original })
    response.resolve('exited')
    await response.promise
    expect(receivers).toEqual([true])
    expect(record).not.toHaveBeenCalled()
  })
  it('stops recovery before foreground or explicit status reads when the captured handle is missing', async () => {
    const runtime = new OrcaRuntimeService()
    const ptyId = 'pty-status'
    runtime['recordPtyWorktree'](ptyId, 'workspace-status')
    runtime['recheckHookAgentPresenceForPty'] = () => Promise.resolve('unverifiable')
    const foreground = vi.fn()
    const explicit = vi.fn()
    runtime['readPtyForegroundProcessFromController'] = foreground
    runtime['getFreshExplicitAgentStatusForPty'] = explicit
    runtime['confirmPtyAgentExit'](ptyId, true)
    await Promise.resolve()
    expect(foreground).not.toHaveBeenCalled()
    expect(explicit).not.toHaveBeenCalled()
  })
})
