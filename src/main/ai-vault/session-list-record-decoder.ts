import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { FlexAssembler, objectRule } from 'stream-json/core/utils/flex-assembler.js'
import type { Token } from 'stream-json/core/parser.js'
import { createJsonTokenReader } from '../../shared/json-token-reader'
import { throwIfAiVaultScanCancelled } from './ai-vault-scan-cancellation'
import { noteAiVaultScanProgress } from './ai-vault-scan-progress'
import { asRecord, parseJsonObject } from './session-scanner-values'

type JsonPath = (string | number)[]
const TOKEN_BATCH = 64 * 1024
const CLAUDE_FIELDS = new Set([
  'sessionId', 'timestamp', 'cwd', 'gitBranch', 'type', 'customTitle', 'aiTitle',
  'agentName', 'operation', 'content', 'lastPrompt', 'isMeta', 'message'
])
const CODEX_FIELDS = new Set([
  'id', 'cwd', 'git', 'history_mode', 'title', 'thread_name', 'threadName',
  'thread_source', 'threadSource', 'source', 'parent_thread_id', 'agent_nickname',
  'agent_role', 'agent_type', 'agent_path', 'model', 'model_name', 'metadata',
  'info', 'type', 'role', 'content', 'message', 'item'
])
const USAGE_FIELDS = new Set([
  'input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
  'cached_input_tokens', 'reasoning_output_tokens', 'total_tokens'
])

// The normalizers read only direct strings and direct text/content parts.
function selectsContent(path: JsonPath): boolean {
  return path.length === 0 ||
    (typeof path[0] === 'number' &&
      (path.length === 1 ||
        (path.length === 2 && (path[1] === 'text' || path[1] === 'content'))))
}

function selectsListField(agent: 'claude' | 'codex', path: JsonPath): boolean {
  if (path.length === 0) {
    return true
  }
  const [root, field, child, leaf] = path
  if (agent === 'claude') {
    if (path.length === 1) {
      return typeof root === 'string' && CLAUDE_FIELDS.has(root)
    }
    if (root !== 'message') {
      return false
    }
    if (path.length === 2) {
      return field === 'content' || field === 'model' || field === 'usage'
    }
    if (field === 'content') {
      return selectsContent(path.slice(2))
    }
    return field === 'usage' && path.length === 3 &&
      typeof child === 'string' && USAGE_FIELDS.has(child)
  }
  if (path.length === 1) {
    return root === 'timestamp' || root === 'type' || root === 'payload'
  }
  if (root !== 'payload') {
    return false
  }
  if (path.length === 2) {
    return typeof field === 'string' && CODEX_FIELDS.has(field)
  }
  // Union tags depend on every own key, including ones unknown to this build.
  if (field === 'source') {
    return true
  }
  if (field === 'content' || field === 'message') {
    return selectsContent(path.slice(2))
  }
  if (field === 'git') {
    return path.length === 3 && (child === 'branch' || child === 'current_branch')
  }
  if (field === 'metadata') {
    return path.length === 3 && child === 'model'
  }
  if (field === 'item') {
    return path.length === 3 ? child === 'type' || child === 'content' :
      child === 'content' && selectsContent(path.slice(3))
  }
  if (field !== 'info') {
    return false
  }
  if (path.length === 3) {
    return child === 'model' || child === 'total_token_usage' || child === 'last_token_usage'
  }
  return path.length === 4 && (child === 'total_token_usage' || child === 'last_token_usage') &&
    typeof leaf === 'string' && USAGE_FIELDS.has(leaf)
}

/** Validate the entire record, assembling only canonical list-reducer inputs. */
export async function decodeSessionListRecord(
  agent: 'claude' | 'codex',
  line: string,
  signal?: AbortSignal
): Promise<Record<string, unknown> | null> {
  throwIfAiVaultScanCancelled(signal)
  if (line.length < 16 * 1024) {
    return parseJsonObject(line)
  }
  const assembler = new FlexAssembler({
    maxDepth: Infinity,
    objectRules: [objectRule<Record<string, unknown>>({
      filter: () => true,
      create: () => Object.create(null),
      add: (target, key, value) => { target[key] = value }
    })]
  })
  const stack: { path: JsonPath; key: string | number; selected: boolean }[] = []
  let selectedValue = false
  let value = ''
  const startValue = (): { path: JsonPath; selected: boolean } => {
    const parent = stack.at(-1)
    const path = parent?.selected ? [...parent.path, parent.key] : []
    const selected = (parent?.selected ?? true) && selectsListField(agent, path)
    // Forward each real key: repeated objects must replace, never merge.
    if (selected && typeof parent?.key === 'string') {
      assembler.consume({ name: 'keyValue', value: parent.key })
    }
    return { path, selected }
  }
  const endValue = (): void => {
    const parent = stack.at(-1)
    if (parent && typeof parent.key === 'number') {
      parent.key++
    }
  }
  const parser = createJsonTokenReader((token: Token) => {
    switch (token.name) {
      case 'keyValue': {
        const parent = stack.at(-1)
        if (parent) {
          parent.key = token.value
        }
        break
      }
      case 'startObject':
      case 'startArray': {
        const frame = startValue()
        stack.push({ ...frame, key: token.name === 'startArray' ? 0 : '' })
        if (frame.selected) {
          assembler.consume(token)
        }
        break
      }
      case 'endObject':
      case 'endArray':
        if (stack.pop()?.selected) {
          assembler.consume(token)
        }
        endValue()
        break
      case 'startString':
      case 'startNumber':
        selectedValue = startValue().selected
        value = ''
        break
      case 'stringChunk':
      case 'numberChunk':
        if (selectedValue) {
          value += token.value
        }
        break
      case 'endString':
      case 'endNumber':
        if (selectedValue) {
          assembler.consume({ name: token.name === 'endString' ? 'stringValue' : 'numberValue', value })
        }
        value = ''
        selectedValue = false
        endValue()
        break
      case 'nullValue':
      case 'trueValue':
      case 'falseValue':
        if (startValue().selected) {
          assembler.consume(token)
        }
        endValue()
        break
    }
  }, TOKEN_BATCH, true)
  try {
    for (let offset = 0; offset < line.length; offset += TOKEN_BATCH) {
      throwIfAiVaultScanCancelled(signal)
      noteAiVaultScanProgress(signal)
      parser.write(line.slice(offset, offset + TOKEN_BATCH))
      await yieldToEventLoop()
    }
    throwIfAiVaultScanCancelled(signal)
    parser.end()
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null
    }
    throw error
  }
  return assembler.done ? asRecord(assembler.current) : null
}
