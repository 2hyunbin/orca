import type { TuiAgent } from './tui-agent'

/**
 * Agents Orca can place an installed skill for.
 *
 * `null` segments mean the agent reads the canonical `.agents/skills` root at
 * that scope, so it needs no placement of its own. Ids are Orca agent ids so a
 * detected agent maps straight to a destination.
 */
type SkillInstallProviderEntry = {
  id: TuiAgent
  displayName: string
  globalSegments: readonly string[] | null
  workspaceSegments: readonly string[] | null
  /** Env var relocating the agent's home (skills in `<home>/skills`); the WSL probe is still Grok-only. */
  homeEnv?: string
}

export const SKILL_INSTALL_PROVIDERS = Object.freeze([
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
] satisfies SkillInstallProviderEntry[])

export type SkillInstallProviderDefinition = (typeof SKILL_INSTALL_PROVIDERS)[number]
export type SkillInstallProviderId = SkillInstallProviderDefinition['id']

export function isSkillInstallProviderId(value: string): value is SkillInstallProviderId {
  return SKILL_INSTALL_PROVIDERS.some((provider) => provider.id === value)
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
