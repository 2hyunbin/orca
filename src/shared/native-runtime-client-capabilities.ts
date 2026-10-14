import { AUTOMATION_RUNTIME_CLIENT_CAPABILITIES } from './automation-runtime-capabilities'
import { AGENT_LAUNCH_RUNTIME_CAPABILITY } from './agent-launch-runtime-capability'

export const SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY = 'session-tabs.close-intent.v1' as const

export const AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY =
  'agent-session.session-boundary.v1' as const

export const WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-defaults.v1' as const

export const WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY =
  'worktree.visibility-source-defaults.v1' as const

export const WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY =
  'worktree.github-pr-suppression.v1' as const

export const REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY =
  'repo.search-qualified-refs.v1' as const

// Generic native clients include the CLI and must not claim Electron-only page
// placement support.
export const NATIVE_REMOTE_RUNTIME_CLIENT_CAPABILITIES = [
  SESSION_TAB_CLOSE_INTENT_RUNTIME_CAPABILITY,
  AGENT_SESSION_BOUNDARY_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
  WORKTREE_GITHUB_PR_SUPPRESSION_RUNTIME_CAPABILITY,
  REPO_SEARCH_QUALIFIED_REFS_RUNTIME_CAPABILITY,
  ...AUTOMATION_RUNTIME_CLIENT_CAPABILITIES,
  AGENT_LAUNCH_RUNTIME_CAPABILITY
] as const
