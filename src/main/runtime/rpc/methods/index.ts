import { lazyRpcMethods } from '../lazy-methods'
import { RPC_METHOD_GROUP_LOADERS as loaders } from './method-loaders'
import { RPC_METHOD_METADATA as metadata } from './method-metadata.generated'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../shared/sidebar-inputs-switch'

// Keep registration order and the full RPC/security surface visible in one manifest.
export const ALL_RPC_METHODS = [
  ...lazyRpcMethods(metadata.STATUS_METHODS, loaders.STATUS_METHODS),
  ...lazyRpcMethods(metadata.ORCAD_TERMINAL_CENSUS_METHODS, loaders.ORCAD_TERMINAL_CENSUS_METHODS),
  ...lazyRpcMethods(metadata.ORCAD_MIGRATION_METHODS, loaders.ORCAD_MIGRATION_METHODS),
  ...lazyRpcMethods(metadata.AGENT_HOOK_METHODS, loaders.AGENT_HOOK_METHODS),
  ...lazyRpcMethods(metadata.AI_VAULT_METHODS, loaders.AI_VAULT_METHODS),
  ...lazyRpcMethods(metadata.ARTIFACT_METHODS, loaders.ARTIFACT_METHODS),
  ...lazyRpcMethods(metadata.AUTOMATION_METHODS, loaders.AUTOMATION_METHODS),
  ...lazyRpcMethods(metadata.REPO_METHODS, loaders.REPO_METHODS),
  ...lazyRpcMethods(metadata.WORKTREE_METHODS, loaders.WORKTREE_METHODS),
  ...lazyRpcMethods(metadata.REFERENCE_METHODS, loaders.REFERENCE_METHODS),
  ...lazyRpcMethods(metadata.AGENT_SESSION_METHODS, loaders.AGENT_SESSION_METHODS),
  ...lazyRpcMethods(
    metadata.STRUCTURED_AGENT_SESSION_METHODS,
    loaders.STRUCTURED_AGENT_SESSION_METHODS
  ),
  ...lazyRpcMethods(
    metadata.STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS,
    loaders.STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS
  ),
  ...lazyRpcMethods(
    metadata.STRUCTURED_AGENT_SESSION_VISUAL_METHODS,
    loaders.STRUCTURED_AGENT_SESSION_VISUAL_METHODS
  ),
  ...lazyRpcMethods(
    metadata.STRUCTURED_AGENT_SESSION_AGENTS_METHODS,
    loaders.STRUCTURED_AGENT_SESSION_AGENTS_METHODS
  ),
  ...lazyRpcMethods(
    metadata.MANAGED_RUNTIME_INSTALL_METHODS,
    loaders.MANAGED_RUNTIME_INSTALL_METHODS
  ),
  ...lazyRpcMethods(metadata.AGENT_LAUNCH_METHODS, loaders.AGENT_LAUNCH_METHODS),
  ...lazyRpcMethods(metadata.CONNECTOR_METHODS, loaders.CONNECTOR_METHODS),
  ...lazyRpcMethods(metadata.TERMINAL_METHODS, loaders.TERMINAL_METHODS),
  ...lazyRpcMethods(metadata.TERMINAL_ORPHAN_METHODS, loaders.TERMINAL_ORPHAN_METHODS),
  ...lazyRpcMethods(metadata.BROWSER_CORE_METHODS, loaders.BROWSER_CORE_METHODS),
  ...lazyRpcMethods(metadata.BROWSER_IDENTITY_METHODS, loaders.BROWSER_IDENTITY_METHODS),
  ...lazyRpcMethods(metadata.BROWSER_SCREENCAST_METHODS, loaders.BROWSER_SCREENCAST_METHODS),
  ...lazyRpcMethods(metadata.BROWSER_EXTRA_METHODS, loaders.BROWSER_EXTRA_METHODS),
  ...lazyRpcMethods(metadata.BROWSER_CLIENT_HOST_METHODS, loaders.BROWSER_CLIENT_HOST_METHODS),
  ...lazyRpcMethods(
    metadata.DESKTOP_BROWSER_BRIDGE_RPC_METHODS,
    loaders.DESKTOP_BROWSER_BRIDGE_RPC_METHODS
  ),
  ...lazyRpcMethods(
    metadata.BROWSER_CLIENT_FILE_CHANNEL_METHODS,
    loaders.BROWSER_CLIENT_FILE_CHANNEL_METHODS
  ),
  ...lazyRpcMethods(
    metadata.BROWSER_NETWORK_TUNNEL_METHODS,
    loaders.BROWSER_NETWORK_TUNNEL_METHODS
  ),
  ...lazyRpcMethods(metadata.ORCHESTRATION_METHODS, loaders.ORCHESTRATION_METHODS),
  ...lazyRpcMethods(metadata.NOTIFICATION_METHODS, loaders.NOTIFICATION_METHODS),
  ...lazyRpcMethods(metadata.STATS_METHODS, loaders.STATS_METHODS),
  ...lazyRpcMethods(metadata.DIAGNOSTICS_METHODS, loaders.DIAGNOSTICS_METHODS),
  ...lazyRpcMethods(metadata.TERMINAL_DAEMON_METHODS, loaders.TERMINAL_DAEMON_METHODS),
  ...lazyRpcMethods(metadata.ACCOUNT_METHODS, loaders.ACCOUNT_METHODS),
  ...lazyRpcMethods(metadata.ANTIGRAVITY_ACCOUNT_METHODS, loaders.ANTIGRAVITY_ACCOUNT_METHODS),
  ...lazyRpcMethods(metadata.USAGE_CREDENTIAL_METHODS, loaders.USAGE_CREDENTIAL_METHODS),
  ...lazyRpcMethods(metadata.PREFLIGHT_METHODS, loaders.PREFLIGHT_METHODS),
  ...lazyRpcMethods(metadata.COMPUTER_METHODS, loaders.COMPUTER_METHODS),
  ...lazyRpcMethods(metadata.SESSION_TAB_METHODS, loaders.SESSION_TAB_METHODS),
  ...lazyRpcMethods(metadata.WORKSPACE_LAYOUT_METHODS, loaders.WORKSPACE_LAYOUT_METHODS),
  // Switch point: a window-owned build registers no layout command.
  ...(ORCA_LAYOUT_OWNER_IS_MAIN
    ? [
        ...lazyRpcMethods(metadata.LAYOUT_APPLY_METHODS, loaders.LAYOUT_APPLY_METHODS),
        ...lazyRpcMethods(metadata.LAYOUT_VIEW_REPORT_METHODS, loaders.LAYOUT_VIEW_REPORT_METHODS)
      ]
    : []),
  ...lazyRpcMethods(metadata.NATIVE_CHAT_METHODS, loaders.NATIVE_CHAT_METHODS),
  ...lazyRpcMethods(metadata.FILE_METHODS, loaders.FILE_METHODS),
  ...lazyRpcMethods(metadata.GIT_METHODS, loaders.GIT_METHODS),
  ...lazyRpcMethods(metadata.GITHUB_METHODS, loaders.GITHUB_METHODS),
  ...lazyRpcMethods(metadata.GITLAB_METHODS, loaders.GITLAB_METHODS),
  ...lazyRpcMethods(metadata.HOSTED_REVIEW_METHODS, loaders.HOSTED_REVIEW_METHODS),
  ...lazyRpcMethods(metadata.LINEAR_METHODS, loaders.LINEAR_METHODS),
  ...lazyRpcMethods(metadata.LINEAR_AGENT_ACCESS_METHODS, loaders.LINEAR_AGENT_ACCESS_METHODS),
  ...lazyRpcMethods(metadata.JIRA_METHODS, loaders.JIRA_METHODS),
  ...lazyRpcMethods(metadata.SSH_METHODS, loaders.SSH_METHODS),
  ...lazyRpcMethods(metadata.MANAGED_SERVER_METHODS, loaders.MANAGED_SERVER_METHODS),
  ...lazyRpcMethods(metadata.SPEECH_METHODS, loaders.SPEECH_METHODS),
  ...lazyRpcMethods(metadata.WORKSPACE_PORT_METHODS, loaders.WORKSPACE_PORT_METHODS),
  ...lazyRpcMethods(metadata.PLUGIN_METHODS, loaders.PLUGIN_METHODS),
  ...lazyRpcMethods(metadata.SKILL_METHODS, loaders.SKILL_METHODS),
  ...lazyRpcMethods(metadata.CLIPBOARD_METHODS, loaders.CLIPBOARD_METHODS),
  ...lazyRpcMethods(metadata.HOST_CAPABILITY_METHODS, loaders.HOST_CAPABILITY_METHODS),
  ...lazyRpcMethods(metadata.MOBILE_WEB_BUNDLE_METHODS, loaders.MOBILE_WEB_BUNDLE_METHODS),
  ...lazyRpcMethods(
    metadata.RUNTIME_CLIENT_CAPABILITY_METHODS,
    loaders.RUNTIME_CLIENT_CAPABILITY_METHODS
  ),
  ...lazyRpcMethods(metadata.CLIENT_EVENT_METHODS, loaders.CLIENT_EVENT_METHODS),
  ...lazyRpcMethods(metadata.CLIENT_UI_METHODS, loaders.CLIENT_UI_METHODS),
  ...lazyRpcMethods(metadata.EMULATOR_METHODS, loaders.EMULATOR_METHODS),
  ...lazyRpcMethods(metadata.PAIRING_METHODS, loaders.PAIRING_METHODS),
  ...lazyRpcMethods(metadata.MOBILE_RELAY_HOSTS_METHODS, loaders.MOBILE_RELAY_HOSTS_METHODS),
  ...lazyRpcMethods(
    metadata.MOBILE_PROJECT_SECTIONS_METHODS,
    loaders.MOBILE_PROJECT_SECTIONS_METHODS
  ),
  // Switch point: a window-fed build publishes no sidebar input.
  ...(ORCA_SIDEBAR_INPUTS_IS_MAIN
    ? lazyRpcMethods(metadata.SIDEBAR_INPUT_METHODS, loaders.SIDEBAR_INPUT_METHODS)
    : []),
  ...lazyRpcMethods(metadata.UPDATER_METHODS, loaders.UPDATER_METHODS),
  ...lazyRpcMethods(metadata.AUTOMATIC_WORK_METHODS, loaders.AUTOMATIC_WORK_METHODS)
]
