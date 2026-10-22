import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY } from '../../../../shared/agent-session-create-capabilities'
import { runtimeChatPermissionSetting } from './web-preference-normalization'
import { getRemoteRuntimeStatus } from './web-runtime-calls'
import { assertActiveEnvironment } from './web-runtime-session'

export function read(settings: Partial<GlobalSettings>): Partial<GlobalSettings> {
  return {
    ...runtimeChatPermissionSetting(settings),
    ...(typeof settings.nativeChatAutoContinueAfterUsageLimit === 'boolean'
      ? { nativeChatAutoContinueAfterUsageLimit: settings.nativeChatAutoContinueAfterUsageLimit }
      : {})
  }
}

export async function updates(
  settings: Partial<GlobalSettings>,
  environmentId: string
): Promise<Partial<GlobalSettings>> {
  const result = runtimeChatPermissionSetting(settings, false)
  if (typeof settings.nativeChatAutoContinueAfterUsageLimit === 'boolean') {
    const status = await getRemoteRuntimeStatus()
    assertActiveEnvironment(environmentId)
    if (status.capabilities?.includes(AGENT_SESSION_USAGE_LIMIT_AUTO_CONTINUE_RUNTIME_CAPABILITY)) {
      return {
        ...result,
        nativeChatAutoContinueAfterUsageLimit: settings.nativeChatAutoContinueAfterUsageLimit
      }
    }
  }
  return result
}
