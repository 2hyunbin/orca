import type { TuiAgent } from './tui-agent'

/**
 * Agents Orca can place an installed skill for.
 *
 * `null` segments mean the agent reads the canonical `.agents/skills` root at
 * that scope, so it needs no placement of its own. Ids match the detection ids
 * in `tui-agent-config.ts` so a detected agent maps straight to a destination.
 */
export type SkillInstallProviderId = OrcaAgentIds<
  | 'codex'
  | 'claude'
  | 'cursor'
  | 'gemini'
  | 'droid'
  | 'continue'
  | 'trae'
  | 'grok'
  | 'aug'
  | 'muse'
  | 'zcode'
>

// Fails to compile when a provider id is not an Orca agent id.
type OrcaAgentIds<T extends TuiAgent> = T

export type SkillInstallProviderDefinition = {
  id: SkillInstallProviderId
  displayName: string
  globalSegments: readonly string[] | null
  workspaceSegments: readonly string[] | null
  /** Skill source label is `<shortName ?? displayName> home`. */
  shortName?: string
  /** Env var relocating the agent's home (skills in `<home>/skills`); the WSL probe is still Grok-only. */
  homeEnv?: string
}

export const SKILL_INSTALL_PROVIDERS: readonly SkillInstallProviderDefinition[] = [
  // Why: Codex reads the canonical .agents/skills root at both scopes.
  {
    id: 'codex',
    displayName: 'Codex',
    globalSegments: null,
    workspaceSegments: null
  },
  {
    id: 'claude',
    displayName: 'Claude Code',
    shortName: 'Claude',
    globalSegments: ['.claude', 'skills'],
    workspaceSegments: ['.claude', 'skills'],
    homeEnv: 'CLAUDE_CONFIG_DIR'
  },
  // Why: Cursor and Gemini read the canonical root inside a project but keep
  // their own home directory, so they only need a placement at global scope.
  {
    id: 'cursor',
    displayName: 'Cursor',
    globalSegments: ['.cursor', 'skills'],
    workspaceSegments: null
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    shortName: 'Gemini',
    globalSegments: ['.gemini', 'skills'],
    workspaceSegments: null
  },
  {
    id: 'droid',
    displayName: 'Droid',
    globalSegments: ['.factory', 'skills'],
    workspaceSegments: ['.factory', 'skills']
  },
  {
    id: 'continue',
    displayName: 'Continue',
    globalSegments: ['.continue', 'skills'],
    workspaceSegments: ['.continue', 'skills']
  },
  {
    id: 'trae',
    displayName: 'Trae',
    globalSegments: ['.trae-cn', 'skills'],
    workspaceSegments: ['.trae', 'skills']
  },
  {
    id: 'grok',
    displayName: 'Grok',
    globalSegments: ['.grok', 'skills'],
    workspaceSegments: ['.grok', 'skills'],
    homeEnv: 'GROK_HOME'
  },
  {
    id: 'aug',
    displayName: 'Augment',
    globalSegments: ['.augment', 'skills'],
    workspaceSegments: ['.augment', 'skills']
  },
  // Why: Muse reads the canonical .agents/skills root at both scopes.
  {
    id: 'muse',
    displayName: 'Muse',
    globalSegments: null,
    workspaceSegments: null
  },
  // Why: ZCode loads user skills from `~/.zcode/skills`; project skills come from the
  // canonical `.agents/skills` root the shared repo source already covers.
  {
    id: 'zcode',
    displayName: 'ZCode',
    globalSegments: ['.zcode', 'skills'],
    workspaceSegments: null
  }
]

const PROVIDERS_BY_ID = new Map(SKILL_INSTALL_PROVIDERS.map((provider) => [provider.id, provider]))

export function isSkillInstallProviderId(value: string): value is SkillInstallProviderId {
  return PROVIDERS_BY_ID.has(value as SkillInstallProviderId)
}

/**
 * An explicit choice is authoritative, including agents the target may install
 * later. Removal passes no choice so it can clean every previously used root.
 */
export function selectedOrDetectedSkillProviders(
  detectedProviders: readonly string[],
  selectedProviders: readonly string[] | undefined
): readonly string[] {
  return selectedProviders ?? detectedProviders
}
