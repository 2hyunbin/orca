import { stampRuntimeSourceEnv } from '../../shared/runtime-source-env'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-scrub-safe-env'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../shared/agent-session-caller-env'
import {
  AGENT_HOOK_RUNTIME_ENV_KEYS,
  ORCA_AGENT_SESSION_CALLER_ENV_KEYS
} from '../ipc/pty/host-env/spawn-env-keys'
import { NATIVE_CHAT_VISUALS_DIR_ENV } from '../native-chat/native-chat-visuals-delivery'

/**
 * What an Orca spawn names its child by: a terminal pane's identity, workspace hints and hook route,
 * a chat session's caller identity, and a chat's visuals folder. Orca never sets these on itself, so
 * a host that holds one at startup was launched from inside that pane or chat (`pnpm dev`, `orca
 * serve` or the app run from an Orca terminal), and every child it spawns would claim to be it.
 */
const INHERITED_LAUNCH_IDENTITY_ENV_KEYS = [
  'ORCA_PANE_KEY',
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID',
  'ORCA_PROJECT_GROUP_ID',
  'ORCA_WORKSPACE_ROOT',
  'ORCA_AGENT_LAUNCH_TOKEN',
  'ORCA_TERMINAL_HANDLE',
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ...AGENT_HOOK_RUNTIME_ENV_KEYS,
  ...ORCA_AGENT_SESSION_CALLER_ENV_KEYS,
  ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV,
  NATIVE_CHAT_VISUALS_DIR_ENV
] as const

/** Drops the launching pane's or chat's identity from a host's own environment, once at startup,
 *  so nothing the host spawns inherits it. */
export function dropInheritedLaunchIdentityEnv(env: Record<string, string | undefined>): void {
  for (const key of INHERITED_LAUNCH_IDENTITY_ENV_KEYS) {
    delete env[key]
  }
  stampRuntimeSourceEnv(env, null)
}
