import { agentRequiredValueOptions } from './agent-session-option-agent-args'
import { agentPermissionArgs, agentPermissionChoices } from './tui-agent-permission-choice'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export const CODEX_PERMISSION_CONFIG_ROOTS = [
  'approval_policy',
  'sandbox_mode',
  'approvals_reviewer',
  'sandbox_workspace_write'
] as const

const CLAUDE_PERMISSION_OPTIONS = [
  '--permission-mode',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools'
]
const EXTRA_CARRIERS: Partial<Record<TuiAgent, readonly string[]>> = {
  claude: CLAUDE_PERMISSION_OPTIONS,
  'claude-agent-teams': CLAUDE_PERMISSION_OPTIONS,
  codex: ['-a', '--ask-for-approval', '-s', '--sandbox', '--yolo', '--not-so-yolo', '--full-auto'],
  grok: ['--permission-mode', '--always-approve', '--yolo', '--dangerously-skip-permissions']
}
const CODEX_VALUES = [
  '-a',
  '--ask-for-approval',
  '-s',
  '--sandbox',
  '-c',
  '--config',
  '-m',
  '--model',
  '--local-provider',
  '--enable',
  '--disable'
]
const MODEL_VALUES = ['--model', '--effort']
const CLAUDE_VARIADIC = [
  '--tools',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--plugin-dir'
]
const PERMISSION_LAUNCH_GRAMMARS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

function words(text: string): string[] {
  const parsed = tokenizeStartupCommand(text, 'posix')
  return parsed.ok ? parsed.tokens : []
}

function optionName(agent: TuiAgent, token: string): string {
  if (agent === 'codex' && /^-[acms].+/.test(token)) {
    return token.slice(0, 2)
  }
  return token.split('=', 1)[0]
}

/** Literal CLI roots: shell quoting is already removed; TOML quoted keys are not decoded. */
function isPermissionConfig(value: string | undefined): boolean {
  if (!value?.includes('=')) {
    return false
  }
  const root = value.slice(0, value.indexOf('=')).trim().split('.')[0]
  return CODEX_PERMISSION_CONFIG_ROOTS.some((key) => key === root)
}

type PermissionOptionInventory = {
  values: Set<string>
  carriers: Set<string>
  switches: Set<string>
}
function permissionOptionInventory(agent: TuiAgent): PermissionOptionInventory {
  const recipes = agentPermissionChoices(agent).flatMap((choice) => {
    const tokens = words(agentPermissionArgs(agent, choice))
    return tokens.map((token, index) => ({ token, next: tokens[index + 1] }))
  })
  const carriers = new Set(EXTRA_CARRIERS[agent])
  const values = new Set(agent === 'codex' ? CODEX_VALUES : [])
  const switches = new Set<string>()
  for (const { token, next } of recipes) {
    if (!token.startsWith('-')) {
      continue
    }
    const name = optionName(agent, token)
    if (name !== '-c' && name !== '--config') {
      carriers.add(name)
    }
    if (token === name && next && !next.startsWith('-')) {
      values.add(name)
    } else {
      switches.add(name)
    }
  }
  return { carriers, values, switches }
}

/** Bounded root-option ownership. Unknown regions stay uncertain, never rejected. */
function analyzeAgentPermissionWords(agent: TuiAgent, tokens: readonly string[]) {
  const inventory = permissionOptionInventory(agent)
  const claude = agent === 'claude' || agent === 'claude-agent-teams'
  const required = agentRequiredValueOptions(agent)
  const roles: string[] = []
  const optionIndices = new Set<number>()
  let uncertain = false
  let terminated = false
  let carrier = false
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (terminated) {
      roles[index] = 'positional'
      continue
    }
    if (token === '--' && !uncertain) {
      roles[index] = 'terminator'
      terminated = true
      continue
    }
    const name = optionName(agent, token)
    const inline = token !== name
    const value = inline
      ? token.slice(name.length + (token[name.length] === '=' ? 1 : 0))
      : tokens[index + 1]
    const policy =
      inventory.carriers.has(name) ||
      (agent === 'codex' && ['-c', '--config'].includes(name) && isPermissionConfig(value))
    if (policy) {
      carrier = true
    }
    const knownValue =
      inventory.values.has(name) ||
      required.includes(name) ||
      (['claude', 'claude-agent-teams', 'grok', 'codex'].includes(agent) &&
        MODEL_VALUES.includes(name))
    const known =
      knownValue ||
      inventory.carriers.has(name) ||
      inventory.switches.has(name) ||
      (agent === 'codex' && ['--search', '--oss', '--no-alt-screen'].includes(name))
    roles[index] = uncertain || !known ? 'uncertain' : `option:${name}`
    if (!uncertain && known) {
      optionIndices.add(index)
    }
    if (!known) {
      uncertain = true
    }
    if (!knownValue || inline || uncertain) {
      continue
    }
    const consumesDash = required.includes(name)
    if (value === undefined || (!consumesDash && value.startsWith('-'))) {
      continue
    }
    roles[++index] = uncertain ? 'uncertain' : `value:${name}`
    if (claude && CLAUDE_VARIADIC.includes(name)) {
      while (tokens[index + 1] !== undefined && !tokens[index + 1].startsWith('-')) {
        roles[++index] = uncertain ? 'uncertain' : `value:${name}`
      }
    }
  }
  return { roles, optionIndices, carrier }
}

export function agentArgsSetPermission(agent: TuiAgent, text: string | null | undefined): boolean {
  return PERMISSION_LAUNCH_GRAMMARS.some((grammar) => {
    const parsed = tokenizeStartupCommand(text ?? '', grammar)
    return parsed.ok && analyzeAgentPermissionWords(agent, parsed.tokens).carrier
  })
}

/** Extraction must preserve both shell words and their CLI owners after prefix composition. */
export function permissionRecipeCut(
  agent: TuiAgent,
  text: string,
  recipe: string
): { args: string } | null {
  const recipeTokens = tokenizeStartupCommand(recipe, 'posix')
  const wanted = words(recipe)
  const rawRecipe = recipeTokens.ok
    ? recipeTokens.spans.map((span) => recipe.slice(span.start, span.end))
    : []
  if (!wanted.length) {
    return null
  }
  const first = tokenizeStartupCommand(text, 'posix')
  if (!first.ok) {
    return null
  }
  for (let index = 0; index + wanted.length <= first.tokens.length; index += 1) {
    const run = first.spans.slice(index, index + wanted.length)
    const last = run.at(-1)
    if (
      !last ||
      !run.every((span, offset) => text.slice(span.start, span.end) === rawRecipe[offset])
    ) {
      continue
    }
    const start = run[0].start
    const end = last.end
    const before = text.slice(0, start).trimEnd()
    const after = text.slice(end).trimStart()
    const args = before && after ? `${before} ${after}` : before || after
    const proven = PERMISSION_LAUNCH_GRAMMARS.every((grammar) => {
      const parsed = tokenizeStartupCommand(text, grammar)
      const cut = tokenizeStartupCommand(args, grammar)
      if (!parsed.ok || !cut.ok) {
        return false
      }
      const offset = parsed.spans.findIndex((span) => span.start === start)
      if (
        offset === -1 ||
        !wanted.every(
          (word, n) =>
            parsed.tokens[offset + n] === word &&
            text.slice(parsed.spans[offset + n].start, parsed.spans[offset + n].end) ===
              rawRecipe[n]
        )
      ) {
        return false
      }
      const kept = parsed.tokens.filter((_, n) => n < offset || n >= offset + wanted.length)
      if (kept.length !== cut.tokens.length || !kept.every((word, n) => word === cut.tokens[n])) {
        return false
      }
      if (analyzeAgentPermissionWords(agent, cut.tokens).carrier) {
        return false
      }
      // A leading exact recipe reconstructs the original argv, even with an unknown remainder.
      if (offset === 0) {
        return true
      }
      const original = analyzeAgentPermissionWords(agent, parsed.tokens)
      if (!original.optionIndices.has(offset) || original.roles.includes('uncertain')) {
        return false
      }
      const composed = analyzeAgentPermissionWords(agent, [...wanted, ...cut.tokens])
      const keptRoles = original.roles.filter((_, n) => n < offset || n >= offset + wanted.length)
      return keptRoles.every((role, n) => role === composed.roles[wanted.length + n])
    })
    if (proven) {
      return { args }
    }
  }
  return null
}
