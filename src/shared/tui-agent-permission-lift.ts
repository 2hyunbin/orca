import type { AgentChatPermissionMode } from './agent-chat-permission-mode'
import type { CommandTokenSpan } from './commit-message-prompt'
import type { GlobalSettings } from './global-settings-types'
import {
  agentPermissionArgs,
  agentPermissionChoices,
  agentPermissionEnv,
  hasTypedAgentPermission,
  normalizeAgentPermissionOverrides,
  PERMISSION_CHOICE_AGENTS,
  resolveAgentPermission,
  type AgentPermissionChoice
} from './tui-agent-permission-choice'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

// Recognizes Orca's own permission flags typed into an agent's Arguments, so they become its
// stored choice instead of text. Only the exact recipes Orca writes are recognized.

/** Every grammar Orca launches with: a cut must mean the same under each. */
const LAUNCH_GRAMMARS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

// Options that change permissions without being part of one of Orca's recipes.
const PERMISSION_OPTION_ALIASES: Partial<Record<TuiAgent, readonly string[]>> = {
  claude: ['--allow-dangerously-skip-permissions'],
  'claude-agent-teams': ['--allow-dangerously-skip-permissions'],
  codex: ['--ask-for-approval', '--sandbox', '--full-auto']
}

// `-c` is Codex's generic config switch; only its approvals_reviewer key is a permission.
const GENERIC_OPTIONS = new Set(['-c'])

type Words = { tokens: string[]; spans: CommandTokenSpan[] }

/** Tokens up to any `--`; operands after it are prompt text, never options. */
function optionWords(text: string, grammar: AgentStartupShell): Words | null {
  const tokenized = tokenizeStartupCommand(text, grammar)
  if (!tokenized.ok) {
    return null
  }
  const end = tokenized.tokens.indexOf('--')
  return end === -1
    ? tokenized
    : { tokens: tokenized.tokens.slice(0, end), spans: tokenized.spans.slice(0, end) }
}

function rawWords(text: string): string[] {
  const words = optionWords(text, 'posix')
  return words ? words.spans.map((span) => text.slice(span.start, span.end)) : []
}

const optionNamesCache = new Map<TuiAgent, Set<string>>()

function permissionOptionNames(agent: TuiAgent): Set<string> {
  let names = optionNamesCache.get(agent)
  if (!names) {
    names = new Set(PERMISSION_OPTION_ALIASES[agent])
    for (const choice of agentPermissionChoices(agent)) {
      for (const word of rawWords(agentPermissionArgs(agent, choice))) {
        if (word.startsWith('-') && !GENERIC_OPTIONS.has(word)) {
          names.add(word)
        }
      }
    }
    optionNamesCache.set(agent, names)
  }
  return names
}

/** Whether this text sets the agent's permissions under any grammar Orca launches with. */
export function agentArgsSetPermission(agent: TuiAgent, text: string | null | undefined): boolean {
  const names = permissionOptionNames(agent)
  if (!text?.trim() || names.size === 0) {
    return false
  }
  return LAUNCH_GRAMMARS.some((grammar) =>
    (optionWords(text, grammar)?.tokens ?? []).some((token) =>
      [...names].some((name) => token === name || token.startsWith(`${name}=`))
    )
  )
}

type Hit = { start: number; end: number }

/** The first place every grammar reads these exact words as whole, consecutive words. */
function findWords(text: string, words: readonly string[]): Hit | null {
  const perGrammar: string[][] = []
  for (const grammar of LAUNCH_GRAMMARS) {
    const parsed = optionWords(text, grammar)
    if (!parsed) {
      return null
    }
    const hits: string[] = []
    for (let index = 0; index + words.length <= parsed.spans.length; index += 1) {
      const run = parsed.spans.slice(index, index + words.length)
      const last = run.at(-1)
      if (last && run.every((span, offset) => text.slice(span.start, span.end) === words[offset])) {
        hits.push(`${run[0].start}:${last.end}`)
      }
    }
    perGrammar.push(hits)
  }
  const [first = [], ...others] = perGrammar
  const agreed = first.find((hit) => others.every((hits) => hits.includes(hit)))
  if (!agreed) {
    return null
  }
  const [start, end] = agreed.split(':').map(Number)
  return { start, end }
}

/** Whether every grammar reads the cut text as the old words minus the cut ones. */
function cutKeepsOtherWords(text: string, cut: string, hit: Hit): boolean {
  return LAUNCH_GRAMMARS.every((grammar) => {
    const before = tokenizeStartupCommand(text, grammar)
    const after = tokenizeStartupCommand(cut, grammar)
    if (!before.ok || !after.ok) {
      return false
    }
    const kept = before.tokens.filter(
      (_, index) => before.spans[index].end <= hit.start || before.spans[index].start >= hit.end
    )
    return kept.length === after.tokens.length && kept.every((word, i) => word === after.tokens[i])
  })
}

/**
 * Splits Orca's permission flag out of an agent's Arguments. `choice` is null when no recipe is
 * there, when two recipes disagree, or when the rest still sets permissions; the text is then
 * returned unchanged, so a wrong call keeps the user's words rather than losing them.
 */
export function liftAgentPermissionArgs(
  agent: TuiAgent,
  text: string | null | undefined
): { choice: AgentChatPermissionMode | null; args: string } {
  const original = text?.trim() ?? ''
  let rest = original
  const found = new Set<AgentChatPermissionMode>()
  for (const choice of agentPermissionChoices(agent)) {
    const flag = choice === 'own' ? [] : rawWords(agentPermissionArgs(agent, choice))
    let hit = flag.length > 0 ? findWords(rest, flag) : null
    while (hit && choice !== 'own') {
      const before = rest.slice(0, hit.start).trimEnd()
      const after = rest.slice(hit.end).trimStart()
      const cut = before && after ? `${before} ${after}` : before || after
      if (!cutKeepsOtherWords(rest, cut, hit)) {
        return { choice: null, args: original }
      }
      found.add(choice)
      rest = cut
      hit = findWords(rest, flag)
    }
  }
  const [choice] = found
  if (found.size !== 1 || agentArgsSetPermission(agent, rest)) {
    return { choice: null, args: original }
  }
  return { choice, args: rest }
}

/**
 * Splits an env-driven bypass (Goose's `GOOSE_MODE=auto`) out of an environment record. Names
 * match case-insensitively: Windows reads them that way, and an extra spelling would still win.
 */
export function liftAgentPermissionEnv(
  agent: TuiAgent,
  env: Record<string, string> | null | undefined
): { choice: 'full-access' | null; env: Record<string, string> } {
  const rest = { ...env }
  const bypass = Object.entries(agentPermissionEnv(agent, 'full-access'))
  const matches = (name: string, wanted: string): boolean =>
    name.toLowerCase() === wanted.toLowerCase()
  const setsBypass = ([wanted, value]: [string, string]): boolean => {
    const spellings = Object.entries(rest).filter(([name]) => matches(name, wanted))
    return spellings.length > 0 && spellings.every(([, current]) => current === value)
  }
  if (bypass.length === 0 || !bypass.every(setsBypass)) {
    return { choice: null, env: rest }
  }
  for (const name of Object.keys(rest)) {
    if (bypass.some(([wanted]) => matches(name, wanted))) {
      delete rest[name]
    }
  }
  return { choice: 'full-access', env: rest }
}

type AgentPermissionProfile = Required<
  Pick<
    GlobalSettings,
    'agentDefaultArgs' | 'agentDefaultEnv' | 'agentPermissionDefault' | 'agentPermissionOverrides'
  >
>

/**
 * Moves each agent's permission out of its Arguments into a stored choice, once per profile.
 * Orca's own flags become the choice and leave the text; no flag means the agent's own settings
 * (those terminals passed none). Text that sets permissions some other way is left whole, on own.
 */
export function migrateAgentPermissionChoice(
  settings: Partial<AgentPermissionProfile>
): AgentPermissionProfile {
  const args = { ...settings.agentDefaultArgs }
  const env = { ...settings.agentDefaultEnv }
  if (hasTypedAgentPermission(settings)) {
    return {
      agentDefaultArgs: args,
      agentDefaultEnv: env,
      agentPermissionDefault: settings.agentPermissionDefault ?? 'own',
      agentPermissionOverrides: normalizeAgentPermissionOverrides(settings.agentPermissionOverrides)
    }
  }
  const choices = new Map<TuiAgent, AgentPermissionChoice>()
  const counts = new Map<AgentPermissionChoice, number>()
  for (const agent of PERMISSION_CHOICE_AGENTS) {
    const fromArgs = liftAgentPermissionArgs(agent, args[agent])
    const fromEnv = fromArgs.choice ? null : liftAgentPermissionEnv(agent, env[agent])
    if (fromArgs.choice) {
      args[agent] = fromArgs.args
    } else if (fromEnv?.choice && env[agent]) {
      env[agent] = fromEnv.env
    }
    const choice = fromArgs.choice ?? fromEnv?.choice ?? 'own'
    choices.set(agent, choice)
    counts.set(choice, (counts.get(choice) ?? 0) + 1)
  }
  // The most common choice becomes the all-agents one; ties keep the first counted.
  let agentPermissionDefault: AgentPermissionChoice = 'own'
  for (const [choice, count] of counts) {
    if (count > (counts.get(agentPermissionDefault) ?? 0)) {
      agentPermissionDefault = choice
    }
  }
  const agentPermissionOverrides: Partial<Record<TuiAgent, AgentPermissionChoice>> = {}
  for (const [agent, choice] of choices) {
    if (resolveAgentPermission(agent, { agentPermissionDefault }).choice !== choice) {
      agentPermissionOverrides[agent] = choice
    }
  }
  return {
    agentDefaultArgs: args,
    agentDefaultEnv: env,
    agentPermissionDefault,
    agentPermissionOverrides
  }
}
