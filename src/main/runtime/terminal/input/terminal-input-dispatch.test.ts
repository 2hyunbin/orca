import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { settledWriteStub } from '../../../providers/settled-pty-write-stub'
import type { RuntimeTerminalWriter } from '../../runtime-terminal-writer'
import type { TerminalAgentPrompt } from './terminal-agent-prompt'

const PTY = 'pty-input-dispatch'
const HANDLE = 'term_input_dispatch'

function runtime() {
  const result = new OrcaRuntimeService()
  const write = vi.fn(() => true)
  result.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => null
  })
  result.registerPty(PTY, 'repo::/tmp/input-dispatch', null, {
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    incarnationId: 'input-dispatch-test'
  })
  result.registerPreAllocatedHandleForPty(PTY, HANDLE)
  return result
}

describe('terminal input dispatch through the current runtime', () => {
  it.each(['pty', 'leaf'])('uses the runtime writer override in the %s lane', async (lane) => {
    const target = runtime()
    if (lane === 'leaf') {
      Object.defineProperties(target, {
        getLivePtyForHandle: { value: () => null },
        getLiveLeafForHandle: { value: () => ({ leaf: { writable: true, ptyId: PTY } }) },
        isLeafPtyProvenAbsent: { value: async () => false }
      })
    }
    const writer = vi.fn(function (
      this: OrcaRuntimeService,
      ...args: Parameters<RuntimeTerminalWriter['writeAction']>
    ) {
      expect(this).toBe(target)
      expect(args).toHaveLength(4)
      expect(args[0]).toBe(PTY)
      return Promise.resolve()
    })
    Object.defineProperty(target, 'writeTerminalAction', { value: writer })

    await expect(
      target.sendTerminal(HANDLE, { text: 'hello' }, { inputKind: 'driving' })
    ).resolves.toMatchObject({ accepted: true, bytesWritten: 5 })
    expect(writer).toHaveBeenCalledOnce()
  })

  it.each(['pty', 'leaf'])(
    'captures the prompt writer before spreading options in the %s lane',
    async (lane) => {
      const target = runtime()
      const calls: string[] = []
      if (lane === 'leaf') {
        Object.defineProperties(target, {
          getLivePtyForHandle: { value: () => null },
          getLiveLeafForHandle: { value: () => ({ leaf: { writable: true, ptyId: PTY } }) },
          isLeafPtyProvenAbsent: { value: async () => false }
        })
      }
      const captured = function (
        this: OrcaRuntimeService,
        ...args: Parameters<TerminalAgentPrompt['writeTerminalAgentPrompt']>
      ) {
        expect(this).toBe(target)
        expect(args).toHaveLength(5)
        calls.push('captured')
        return Promise.resolve({ submits: 1 })
      }
      Object.defineProperties(target, {
        serializeAgentPromptSubmission: {
          value: (_id: string, _generation: number, submit: () => Promise<{ submits: number }>) =>
            submit()
        },
        assertLiveTerminalHandleTargetsPty: { value: () => {} },
        assertAgentPromptGeneration: { value: () => {} },
        writeTerminalAgentPrompt: { value: captured, configurable: true }
      })
      const options = { inputKind: 'launch' as const }
      Object.defineProperty(options, 'marker', {
        enumerable: true,
        get() {
          Object.defineProperty(target, 'writeTerminalAgentPrompt', {
            value: () => {
              calls.push('late')
              return Promise.resolve({ submits: 1 })
            }
          })
          return true
        }
      })

      await target.sendTerminalAgentPrompt(HANDLE, 'hello', options)
      expect(calls).toEqual(['captured'])
    }
  )

  it('captures permission validation before the nested activity lookup replaces it', async () => {
    const target = runtime()
    let activityReads = 0
    Object.defineProperties(target, {
      assertAgentPromptGeneration: { value: () => {} },
      getPtyWriteHostPlatform: { value: () => 'linux' },
      getAgentPromptActivity: {
        value: () => {
          activityReads += 1
          if (activityReads === 2) {
            Object.defineProperty(target, 'assertAgentPromptPermissionSafe', {
              value: () => {
                throw new Error('late')
              }
            })
          }
          return {}
        }
      },
      assertAgentPromptPermissionSafe: {
        configurable: true,
        value: function (this: OrcaRuntimeService) {
          expect(this).toBe(target)
          expect(arguments.length).toBe(2)
          if (activityReads === 2) {
            throw new Error('captured')
          }
        }
      }
    })

    await expect(
      target['writeTerminalAgentPrompt'](HANDLE, PTY, 1, 'hello', {
        inputKind: 'driving',
        composerReady: true
      })
    ).rejects.toThrow('captured')
    expect(activityReads).toBe(2)
  })

  it('keeps the activity cache omitted in the baseline read', async () => {
    const target = runtime()
    Object.defineProperty(target, 'assertAgentPromptGeneration', { value: () => {} })
    const activity = vi.fn(function (this: OrcaRuntimeService) {
      expect(this).toBe(target)
      expect(arguments.length).toBe(2)
      throw new Error('baseline reached')
    })
    Object.defineProperty(target, 'getAgentPromptActivity', { value: activity })

    await expect(
      target['writeTerminalAgentPrompt'](HANDLE, PTY, 1, 'hello', { inputKind: 'driving' })
    ).rejects.toThrow('baseline reached')
    expect(activity).toHaveBeenCalledOnce()
  })
})
