import { describe, expect, it } from 'vitest'
import { dropInheritedLaunchIdentityEnv } from './inherited-launch-identity-env'

describe('dropInheritedLaunchIdentityEnv', () => {
  it('drops the pane and chat identity of the Orca terminal that started this host', () => {
    const parentIdentity = {
      ORCA_PANE_KEY: 'tab-parent:leaf-parent',
      ORCA_TAB_ID: 'tab-parent',
      ORCA_WORKTREE_ID: 'global-floating-terminal',
      ORCA_WORKSPACE_ID: 'global-floating-terminal',
      ORCA_PROJECT_GROUP_ID: 'parent-group',
      ORCA_WORKSPACE_ROOT: '/parent/folder',
      ORCA_AGENT_LAUNCH_TOKEN: 'parent-launch',
      ORCA_AGENT_PANE: 'tab-parent:leaf-parent',
      ORCA_AGENT_LAUNCH: 'parent-launch',
      ORCA_TERMINAL_HANDLE: 'term_parent',
      ORCA_AGENT_HOOK_PORT: '4100',
      ORCA_AGENT_HOOK_TOKEN: 'parent-hook-token',
      ORCA_AGENT_HOOK_ENDPOINT: '/parent/endpoint.env',
      ORCA_AGENT_SESSION_ID: 'parent-chat',
      ORCA_STRUCTURED_SESSION: '1',
      ORCA_AGENT_SESSION_SPAWN_TOKEN: 'parent-spawn',
      ORCA_CHAT_VISUALS_DIR: '/parent/visuals',
      ORCA_RUNTIME_SOURCE_ID: 'parent-source',
      ORCA_RUNTIME_SOURCE_INCARNATION: 'parent-runtime'
    }
    const env: Record<string, string | undefined> = {
      ...parentIdentity,
      PATH: '/usr/bin',
      ORCA_USER_DATA_PATH: '/this/profile'
    }

    dropInheritedLaunchIdentityEnv(env)

    expect(env).toEqual({ PATH: '/usr/bin', ORCA_USER_DATA_PATH: '/this/profile' })
  })
})
