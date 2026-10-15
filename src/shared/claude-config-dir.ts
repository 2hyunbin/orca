import { resolve } from 'node:path'
import {
  CLAUDE_INJECTED_CONFIG_DIR_ENV,
  CLAUDE_USER_CONFIG_DIR_ENV
} from './claude-profile-routing'

/** The user's override before each reader applies its path policy. */
export function readUserClaudeConfigDirOverride(env: NodeJS.ProcessEnv): string | undefined {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
  const injected = env[CLAUDE_INJECTED_CONFIG_DIR_ENV]?.trim()
  if (!configDir) {
    return undefined
  }
  if (injected && resolve(injected) === resolve(configDir)) {
    // An outer Orca carries the user's own override beside its injected account home.
    return env[CLAUDE_USER_CONFIG_DIR_ENV]?.trim() || undefined
  }
  return configDir
}
