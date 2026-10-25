import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { isPlainObject, type HooksConfig } from '../agent-hooks/installer-utils'
import {
  CLAUDE_AGENT_VIEW_COMMAND,
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  normalizeClaudeAgentViewChord
} from '../../shared/claude-agent-view'

export function parseClaudeAgentViewBindings(text: string | null): HooksConfig | null {
  if (text === null) {
    return {}
  }
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors, { allowTrailingComma: true })
  return errors.length === 0 && isPlainObject(config) ? config : null
}

export function claudeAgentViewChord(text: string): string | undefined {
  const config = parseClaudeAgentViewBindings(text)
  if (!Array.isArray(config?.bindings)) {
    return undefined
  }
  for (const { chord } of CLAUDE_AGENT_VIEW_SHORTCUTS) {
    let action: unknown
    for (const block of config.bindings) {
      if (!isPlainObject(block) || !isPlainObject(block.bindings)) {
        continue
      }
      if (block.context !== 'Chat' && block.context !== 'Global') {
        continue
      }
      for (const [key, value] of Object.entries(block.bindings)) {
        if (normalizeClaudeAgentViewChord(key) === normalizeClaudeAgentViewChord(chord)) {
          action = value
        }
      }
    }
    if (action === `command:${CLAUDE_AGENT_VIEW_COMMAND}`) {
      return chord
    }
  }
  return undefined
}

export function serializeClaudeAgentViewBindings(
  original: string | null,
  next: HooksConfig
): string {
  if (original === null) {
    return `${JSON.stringify(next, null, 2)}\n`
  }
  const previous = parseClaudeAgentViewBindings(original)
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } }
  if (JSON.stringify(previous) === JSON.stringify(next)) {
    return original
  }
  if (!Array.isArray(previous?.bindings) || !Array.isArray(next.bindings)) {
    return applyEdits(original, modify(original, ['bindings'], next.bindings, options))
  }
  let text = original
  for (let index = 0; index < next.bindings.length; index++) {
    if (index >= previous.bindings.length) {
      text = applyEdits(text, modify(text, ['bindings', -1], next.bindings[index], options))
      continue
    }
    const before = previous.bindings[index]
    const after = next.bindings[index]
    if (
      !isPlainObject(before) ||
      !isPlainObject(before.bindings) ||
      !isPlainObject(after) ||
      !isPlainObject(after.bindings)
    ) {
      continue
    }
    for (const key of Object.keys(before.bindings)) {
      if (!(key in after.bindings)) {
        text = applyEdits(
          text,
          modify(text, ['bindings', index, 'bindings', key], undefined, options)
        )
      }
    }
  }
  return text
}
