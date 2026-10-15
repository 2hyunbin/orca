import { homedir } from 'node:os'
import type { CommandHandler } from '../dispatch'
import { RuntimeClientError } from '../runtime-client'
import { getDefaultUserDataPath } from '../runtime/metadata'
import { writeStdoutLine } from '../stdout-line'
import { getRepeatedStringFlag } from '../flags'
import { loadCanonicalGuides, type BundledSkillGuide } from './bundled-skill-guide-table'
import { detectCommandsInInstallDirs } from '../../shared/local-agent-install-dir-detection'
import { SKILL_INSTALL_PROVIDERS } from '../../shared/skill-install-providers'
import type { SkillInstallResult } from '../../shared/skill-install-contract'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from '../../shared/tui-agent-detection-commands'
import {
  installBundledOrcaSkills,
  planBundledOrcaSkills,
  type BundledOrcaSkillInstallInput,
  type BundledOrcaSkillPlan
} from '../../main/skills/bundled-orca-skill-install'
import {
  describeBundledSkillInstallResult,
  describeSkillConflictReason
} from '../../main/skills/bundled-orca-skill-install-report'
import { resolveEnvironmentSkillProviderRoots } from '../../main/skills/skill-provider-runtime-roots'

export type SkillMutationVerb = 'install' | 'update'

// Why: receipts carry no host meaning for Orca's own skills; this only labels who wrote one.
const CLI_HOST_IDENTITY = 'orca-cli'
const SHARED_FOLDER_ONLY = 'universal'
// Why: earlier releases took the skills CLI's key for Claude Code; scripts still pass it.
const PROVIDER_ALIASES: Readonly<Record<string, string>> = { 'claude-code': 'claude' }

function detectLocalAgents(): string[] {
  const runtime = process.platform
  const probes = getTuiAgentDetectionProbeCommands(KNOWN_TUI_AGENT_DETECTION_COMMANDS, runtime)
  return resolveDetectedTuiAgentIds(
    KNOWN_TUI_AGENT_DETECTION_COMMANDS,
    detectCommandsInInstallDirs(probes),
    runtime
  )
}

function resolveProviders(flags: Map<string, string | boolean>): readonly string[] {
  const requested = flags.get('agent')
  if (flags.has('agent') && typeof requested !== 'string') {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  if (typeof requested !== 'string') {
    return detectLocalAgents()
  }
  // Why one comma-separated value: `agent` is a single-value flag on other commands.
  const values = requested
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  if (values.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --agent')
  }
  const known = new Set<string>(SKILL_INSTALL_PROVIDERS.map((provider) => provider.id))
  const providers = new Set<string>()
  for (const value of values) {
    const provider = PROVIDER_ALIASES[value] ?? value
    if (provider === SHARED_FOLDER_ONLY) {
      continue
    }
    if (!known.has(provider)) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown --agent value "${value}". Use one or more of: ${[...known].join(', ')}, ` +
          `or ${SHARED_FOLDER_ONLY} for the shared .agents/skills directory alone.`
      )
    }
    providers.add(provider)
  }
  return [...providers]
}

function installInput(flags: Map<string, string | boolean>): BundledOrcaSkillInstallInput {
  const scope = flags.get('local') === true ? 'workspace' : 'global'
  const workspaceDirectory = scope === 'workspace' ? process.cwd() : undefined
  return {
    scope,
    homeDirectory: homedir(),
    workspaceDirectory,
    // Why the app's userData: its receipts are what let the app recognise these installs.
    orcaStateDirectory: getDefaultUserDataPath(),
    detectedProviders: resolveProviders(flags),
    providerRootOverrides: scope === 'global' ? resolveEnvironmentSkillProviderRoots() : {},
    hostIdentity: CLI_HOST_IDENTITY,
    destinationIdentity:
      scope === 'global'
        ? `global:${CLI_HOST_IDENTITY}`
        : `workspace:${CLI_HOST_IDENTITY}:${workspaceDirectory}`,
    discardLocalChanges: flags.get('force') === true
  }
}

function describePlan(plan: BundledOrcaSkillPlan): string {
  if (plan.state === 'unchanged') {
    return `${plan.name}: already up to date (${plan.canonicalPath})`
  }
  if (!plan.willWrite) {
    const kind =
      plan.state === 'external-link' || plan.state === 'name-collision' ? plan.state : undefined
    return `${plan.name}: would not change, ${describeSkillConflictReason(kind)} (${plan.canonicalPath})`
  }
  return `${plan.name}: would ${plan.state === 'missing' ? 'install' : 'update'} ${plan.canonicalPath}`
}

function landed(result: SkillInstallResult): boolean {
  return (
    result.status === 'installed' || result.status === 'updated' || result.status === 'unchanged'
  )
}

function formatSkillSelectionHelp(verb: SkillMutationVerb, skillNames: string[]): string {
  return [
    `Choose one or more skills to ${verb}:`,
    ...skillNames.map((name) => `  ${name}`),
    '',
    `Usage: orca skills ${verb} --skill <name> [--skill <name> ...]`,
    `   or: orca skills ${verb} --all`
  ].join('\n')
}

function resolveSelectedSkillNames(
  flags: Map<string, string | boolean>,
  guides: BundledSkillGuide[]
): string[] {
  const requestedSkills = getRepeatedStringFlag(flags, 'skill')
  const selectAll = flags.get('all') === true
  if (flags.has('skill') && requestedSkills.length === 0) {
    throw new RuntimeClientError('invalid_argument', 'Missing required --skill')
  }
  if (selectAll && requestedSkills.length > 0) {
    throw new RuntimeClientError('invalid_argument', 'Use either --all or --skill, not both.')
  }
  if (!selectAll && requestedSkills.length === 0) {
    return []
  }
  if (selectAll) {
    return guides.map((guide) => guide.name)
  }
  const availableTopics = guides.map((guide) => guide.name).join(', ')
  const guideByTopic = new Map<string, BundledSkillGuide>(
    guides.flatMap((guide) => [guide.name, ...guide.aliases].map((name) => [name, guide]))
  )
  const canonicalNames = new Set<string>()
  for (const requested of requestedSkills) {
    const guide = guideByTopic.get(requested)
    if (!guide) {
      throw new RuntimeClientError(
        'invalid_argument',
        `Unknown skill "${requested}". Available skills: ${availableTopics}`
      )
    }
    canonicalNames.add(guide.name)
  }
  return [...canonicalNames].sort()
}

export function createSkillMutationHandler(verb: SkillMutationVerb): CommandHandler {
  return async ({ flags, json }) => {
    const guides = await loadCanonicalGuides()
    const skillNames = resolveSelectedSkillNames(flags, guides)

    if (skillNames.length === 0) {
      const names = guides.map((guide) => guide.name)
      writeStdoutLine(
        json
          ? JSON.stringify({ availableSkills: names }, null, 2)
          : formatSkillSelectionHelp(verb, names)
      )
      return
    }

    // Why: this runs before target resolution because the answer belongs to the
    // other machine — agents detected here would be the wrong host's.
    if (process.env.ORCA_CLI_CWD) {
      throw new RuntimeClientError(
        'invalid_environment',
        `orca skills ${verb} writes to the machine that runs it, but this shell forwards ` +
          `orca to the Orca host. Run the same orca skills ${verb} command on the machine ` +
          "you want it on, where it can detect that host's agents."
      )
    }

    const input = installInput(flags)
    const global = input.scope === 'global'

    if (flags.get('dry-run') === true) {
      const plan = await planBundledOrcaSkills(skillNames, input)
      writeStdoutLine(
        json
          ? JSON.stringify({ skills: skillNames, global, executed: false, plan }, null, 2)
          : `${plan.map(describePlan).join('\n')}\n\nRerun without --dry-run to ${verb} now.`
      )
      return
    }

    const results = await installBundledOrcaSkills(skillNames, input)
    const failed = results.some((result) => !landed(result))
    if (failed) {
      process.exitCode = 1
    }
    if (json) {
      writeStdoutLine(
        JSON.stringify({ skills: skillNames, global, executed: true, results }, null, 2)
      )
      return
    }
    const lines = results.map(describeBundledSkillInstallResult)
    const replaceable = results.some(
      (result) => result.conflict?.kind === 'modified' || result.conflict?.kind === 'unowned'
    )
    if (replaceable) {
      lines.push('', 'Rerun with --force to replace a copy that has local changes.')
    }
    writeStdoutLine(lines.join('\n'))
  }
}
