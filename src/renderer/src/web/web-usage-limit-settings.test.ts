import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../shared/agent-session-create-capabilities'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

beforeEach(() => vi.resetModules())
afterEach(() => vi.unstubAllGlobals())

it.each([true, false])(
  'reads host consent and only writes it to capable web hosts (supported=%s)',
  async (supported) => {
    let consent = true
    const updates: unknown[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'settings.update') {
            updates.push(params)
            if (
              typeof params === 'object' &&
              params !== null &&
              'nativeChatAutoContinueAfterUsageLimit' in params
            ) {
              consent = params.nativeChatAutoContinueAfterUsageLimit === true
            }
          }
          return Promise.resolve({
            id: 'reply',
            ok: true,
            result:
              method === 'status.get'
                ? {
                    capabilities: supported
                      ? [AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY]
                      : []
                  }
                : { settings: supported ? { nativeChatAutoContinueAfterUsageLimit: consent } : {} },
            _meta: { runtimeId: 'runtime-1' }
          })
        }
        close(): void {}
      }
    }))
    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api.settings
    expect((await api.get()).nativeChatAutoContinueAfterUsageLimit).toBe(supported)
    await api.set({ nativeChatAutoContinueAfterUsageLimit: false })
    expect(updates).toEqual(supported ? [{ nativeChatAutoContinueAfterUsageLimit: false }] : [])
    expect((await api.get()).nativeChatAutoContinueAfterUsageLimit).toBe(false)
  }
)
