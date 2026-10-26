export const RPC_METHOD_GROUP_LOADERS = {
  STATUS_METHODS: () => import('./status').then((module) => module.STATUS_METHODS),
  SIDEBAR_INPUT_METHODS: () =>
    import('./sidebar-inputs').then((module) => module.SIDEBAR_INPUT_METHODS),
  ORCAD_TERMINAL_CENSUS_METHODS: () =>
    import('./orcad-terminal-census').then((module) => module.ORCAD_TERMINAL_CENSUS_METHODS),
  ORCAD_MIGRATION_METHODS: () =>
    import('./orcad-migration').then((module) => module.ORCAD_MIGRATION_METHODS),
  AI_VAULT_METHODS: () => import('./ai-vault').then((module) => module.AI_VAULT_METHODS),
  AUTOMATION_METHODS: () => import('./automations').then((module) => module.AUTOMATION_METHODS),
  REPO_METHODS: () => import('./repo').then((module) => module.REPO_METHODS),
  WORKTREE_METHODS: () => import('./worktree').then((module) => module.WORKTREE_METHODS),
  REFERENCE_METHODS: () => import('./reference').then((module) => module.REFERENCE_METHODS),
  TERMINAL_METHODS: () => import('./terminal').then((module) => module.TERMINAL_METHODS),
  TERMINAL_ORPHAN_METHODS: () =>
    import('./terminal-orphan').then((module) => module.TERMINAL_ORPHAN_METHODS),
  BROWSER_CORE_METHODS: () =>
    import('./browser-core').then((module) => module.BROWSER_CORE_METHODS),
  BROWSER_IDENTITY_METHODS: () =>
    import('./browser-identity-rpc').then((module) => module.BROWSER_IDENTITY_METHODS),
  BROWSER_EXTRA_METHODS: () =>
    import('./browser-extras').then((module) => module.BROWSER_EXTRA_METHODS),
  BROWSER_SCREENCAST_METHODS: () =>
    import('./browser-screencast').then((module) => module.BROWSER_SCREENCAST_METHODS),
  BROWSER_CLIENT_HOST_METHODS: () =>
    import('./browser-client-host').then((module) => module.BROWSER_CLIENT_HOST_METHODS),
  DESKTOP_BROWSER_BRIDGE_RPC_METHODS: () =>
    import('./desktop-browser-bridge').then((module) => module.DESKTOP_BROWSER_BRIDGE_RPC_METHODS),
  BROWSER_CLIENT_FILE_CHANNEL_METHODS: () =>
    import('./browser-client-file-channel').then(
      (module) => module.BROWSER_CLIENT_FILE_CHANNEL_METHODS
    ),
  BROWSER_NETWORK_TUNNEL_METHODS: () =>
    import('./browser-network-tunnel').then((module) => module.BROWSER_NETWORK_TUNNEL_METHODS),
  ORCHESTRATION_METHODS: () =>
    import('./orchestration').then((module) => module.ORCHESTRATION_METHODS),
  NOTIFICATION_METHODS: () =>
    import('./notifications').then((module) => module.NOTIFICATION_METHODS),
  STATS_METHODS: () => import('./stats').then((module) => module.STATS_METHODS),
  DIAGNOSTICS_METHODS: () => import('./diagnostics').then((module) => module.DIAGNOSTICS_METHODS),
  TERMINAL_DAEMON_METHODS: () =>
    import('./terminal-daemon').then((module) => module.TERMINAL_DAEMON_METHODS),
  ACCOUNT_METHODS: () => import('./accounts').then((module) => module.ACCOUNT_METHODS),
  ANTIGRAVITY_ACCOUNT_METHODS: () =>
    import('./antigravity-accounts').then((module) => module.ANTIGRAVITY_ACCOUNT_METHODS),
  USAGE_CREDENTIAL_METHODS: () =>
    import('./usage-credentials').then((module) => module.USAGE_CREDENTIAL_METHODS),
  PREFLIGHT_METHODS: () => import('./preflight').then((module) => module.PREFLIGHT_METHODS),
  COMPUTER_METHODS: () => import('./computer').then((module) => module.COMPUTER_METHODS),
  SESSION_TAB_METHODS: () => import('./session-tabs').then((module) => module.SESSION_TAB_METHODS),
  NATIVE_CHAT_METHODS: () => import('./native-chat').then((module) => module.NATIVE_CHAT_METHODS),
  FILE_METHODS: () => import('./files').then((module) => module.FILE_METHODS),
  GIT_METHODS: () => import('./git').then((module) => module.GIT_METHODS),
  GITHUB_METHODS: () => import('./github').then((module) => module.GITHUB_METHODS),
  GITLAB_METHODS: () => import('./gitlab').then((module) => module.GITLAB_METHODS),
  HOSTED_REVIEW_METHODS: () =>
    import('./hosted-review').then((module) => module.HOSTED_REVIEW_METHODS),
  LINEAR_METHODS: () => import('./linear').then((module) => module.LINEAR_METHODS),
  LINEAR_AGENT_ACCESS_METHODS: () =>
    import('./linear-agent-access').then((module) => module.LINEAR_AGENT_ACCESS_METHODS),
  JIRA_METHODS: () => import('./jira').then((module) => module.JIRA_METHODS),
  SSH_METHODS: () => import('./ssh').then((module) => module.SSH_METHODS),
  MANAGED_SERVER_METHODS: () =>
    import('./managed-server').then((module) => module.MANAGED_SERVER_METHODS),
  SPEECH_METHODS: () => import('./speech').then((module) => module.SPEECH_METHODS),
  CLIENT_UI_METHODS: () => import('./client-ui').then((module) => module.CLIENT_UI_METHODS),
  CLIENT_EVENT_METHODS: () =>
    import('./client-events').then((module) => module.CLIENT_EVENT_METHODS),
  WORKSPACE_PORT_METHODS: () =>
    import('./workspace-ports').then((module) => module.WORKSPACE_PORT_METHODS),
  PLUGIN_METHODS: () => import('./plugins').then((module) => module.PLUGIN_METHODS),
  SKILL_METHODS: () => import('./skills').then((module) => module.SKILL_METHODS),
  CLIPBOARD_METHODS: () => import('./clipboard').then((module) => module.CLIPBOARD_METHODS),
  HOST_CAPABILITY_METHODS: () =>
    import('./host-capabilities').then((module) => module.HOST_CAPABILITY_METHODS),
  MOBILE_WEB_BUNDLE_METHODS: () =>
    import('./mobile-web-bundle').then((module) => module.MOBILE_WEB_BUNDLE_METHODS),
  RUNTIME_CLIENT_CAPABILITY_METHODS: () =>
    import('./runtime-client-capabilities').then(
      (module) => module.RUNTIME_CLIENT_CAPABILITY_METHODS
    ),
  EMULATOR_METHODS: () => import('./emulator').then((module) => module.EMULATOR_METHODS),
  PAIRING_METHODS: () => import('./pairing').then((module) => module.PAIRING_METHODS),
  MOBILE_RELAY_HOSTS_METHODS: () =>
    import('./mobile-relay-hosts').then((module) => module.MOBILE_RELAY_HOSTS_METHODS),
  MOBILE_PROJECT_SECTIONS_METHODS: () =>
    import('./mobile-project-sections').then((module) => module.MOBILE_PROJECT_SECTIONS_METHODS),
  UPDATER_METHODS: () => import('./updater').then((module) => module.UPDATER_METHODS),
  AUTOMATIC_WORK_METHODS: () =>
    import('./automatic-work').then((module) => module.AUTOMATIC_WORK_METHODS),
  AGENT_SESSION_METHODS: () =>
    import('./agent-session').then((module) => module.AGENT_SESSION_METHODS),
  STRUCTURED_AGENT_SESSION_METHODS: () =>
    import('./structured-agent-session').then((module) => module.STRUCTURED_AGENT_SESSION_METHODS),
  STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS: () =>
    import('./structured-agent-session-attachments').then(
      (module) => module.STRUCTURED_AGENT_SESSION_ATTACHMENT_METHODS
    ),
  STRUCTURED_AGENT_SESSION_VISUAL_METHODS: () =>
    import('./structured-agent-session-visual').then(
      (module) => module.STRUCTURED_AGENT_SESSION_VISUAL_METHODS
    ),
  STRUCTURED_AGENT_SESSION_AGENTS_METHODS: () =>
    import('./structured-agent-session-agents').then(
      (module) => module.STRUCTURED_AGENT_SESSION_AGENTS_METHODS
    ),
  MANAGED_RUNTIME_INSTALL_METHODS: () =>
    import('./managed-runtime-install').then((module) => module.MANAGED_RUNTIME_INSTALL_METHODS),
  ARTIFACT_METHODS: () => import('./artifacts').then((module) => module.ARTIFACT_METHODS),
  AGENT_HOOK_METHODS: () => import('./agent-hooks').then((module) => module.AGENT_HOOK_METHODS),
  AGENT_LAUNCH_METHODS: () =>
    import('./agent-launch').then((module) => module.AGENT_LAUNCH_METHODS),
  CONNECTOR_METHODS: () => import('./connector').then((module) => module.CONNECTOR_METHODS),
  LAYOUT_APPLY_METHODS: () =>
    import('./workspace-layout').then((module) => module.LAYOUT_APPLY_METHODS),
  LAYOUT_VIEW_REPORT_METHODS: () =>
    import('./workspace-layout').then((module) => module.LAYOUT_VIEW_REPORT_METHODS),
  WORKSPACE_LAYOUT_METHODS: () =>
    import('./workspace-layout').then((module) => module.WORKSPACE_LAYOUT_METHODS)
}
