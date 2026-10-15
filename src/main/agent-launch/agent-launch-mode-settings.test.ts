import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { decideAgentLaunchMode, readAgentLaunchModeSettings } from './agent-launch-mode'

const detect = vi.hoisted(() => vi.fn())
vi.mock('../preflight/agent-detection', () => ({
  detectInstalledAgentsWithShellPathHydration: detect
}))
vi.mock('electron', () => ({ app: { getPath: () => '/orca-state', isPackaged: true } }))

beforeEach(() => detect.mockReset().mockResolvedValue([]))

describe('host launch preference ownership', () => {
  it.each([false, true])(
    'reads saved choices privately with Agents disabled=%s',
    async (disabled) => {
      const settings = {
        ...getDefaultSettings('/tmp'),
        experimentalNativeChat: true,
        nativeChatProviders: { claude: false },
        disabledTuiAgents: disabled ? ['claude'] : []
      }
      const store = { getSettings: () => settings }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: construction and these readers use only getSettings from the fixture.
      const runtime = new OrcaRuntimeService(store as RuntimeStore)
      expect(runtime.getClientSettings()).not.toHaveProperty('nativeChatProviders')
      const mode = decideAgentLaunchMode({
        placement: { agent: 'claude' },
        settings: await readAgentLaunchModeSettings(runtime, 'claude')
      })
      expect(mode.mode).toBe('terminal')
      expect(detect).not.toHaveBeenCalled()
    }
  )

  it.each([false, true])(
    'resolves an untouched provider from native installation=%s',
    async (installed) => {
      detect.mockResolvedValue(installed ? ['grok'] : [])
      const saved = { experimentalNativeChat: true }
      const runtime = { requireStore: () => ({ getSettings: () => saved }) }
      const mode = decideAgentLaunchMode({
        placement: { agent: 'grok' },
        settings: await readAgentLaunchModeSettings(runtime, 'grok')
      })
      expect(mode.mode).toBe(installed ? 'structured' : 'terminal')
      expect(detect).toHaveBeenCalledWith(undefined)
      expect(saved).not.toHaveProperty('nativeChatProviders')
    }
  )

  it.each([false, true])(
    'preserves desktop stamp %s against opposite host choices',
    async (stamp) => {
      const runtime = {
        requireStore: () => ({
          getSettings: () => ({
            experimentalNativeChat: !stamp,
            nativeChatProviders: { grok: !stamp }
          })
        })
      }
      const mode = decideAgentLaunchMode({
        placement: { agent: 'grok' },
        settings: await readAgentLaunchModeSettings(runtime, 'grok', stamp)
      })
      expect(mode.mode).toBe(stamp ? 'structured' : 'terminal')
      expect(detect).not.toHaveBeenCalled()
    }
  )
})
