import { isDeepStrictEqual } from 'node:util'
import { isRecord } from '../../agent-status-child-work-value-guards'
import { readJsonlCursor, type JsonlCursor } from '../../codex-rollout-jsonl-cursor'
import type { AgentProcessIdentity } from '../../agent-process-presence'
import type { ClaudeLeadTurnState } from '../listener-state'

type Verdict = 'working' | 'cancellation' | 'done'
export type ClaudePermissionObservation = {
  cursor: JsonlCursor
  sessionId: string
  launchToken?: string
  process?: AgentProcessIdentity
  toolName: string
  toolAgentType?: string
  input: unknown
  toolUseId?: string
  requiresUniqueInput: boolean
  promptId?: string
  descendants: Set<string>
  anchored: boolean
  result: boolean
  verdict: Verdict
  published?: Verdict
  lead?: ClaudeLeadTurnState
  failures: number
}

function rootRecord(row: Record<string, unknown>, sessionId: string): boolean {
  return (
    (row.isSidechain === false || (row.type === 'system' && row.isSidechain !== true)) &&
    (row.sessionId ?? row.session_id) === sessionId
  )
}

function blocks(row: Record<string, unknown>): Record<string, unknown>[] {
  return isRecord(row.message) && Array.isArray(row.message.content)
    ? row.message.content.filter(isRecord)
    : []
}

function bindRequest(
  observation: ClaudePermissionObservation,
  rows: Record<string, unknown>[]
): number {
  const candidates: { id: string; uuid: string; index: number }[] = []
  const settled = new Set<string>()
  for (const [index, row] of rows.entries()) {
    if (!rootRecord(row, observation.sessionId)) {
      continue
    }
    for (const block of blocks(row)) {
      if (
        row.type === 'user' &&
        block.type === 'tool_result' &&
        typeof block.tool_use_id === 'string'
      ) {
        settled.add(block.tool_use_id)
      }
      if (
        row.type === 'assistant' &&
        block.type === 'tool_use' &&
        block.name === observation.toolName &&
        isDeepStrictEqual(block.input, observation.input) &&
        typeof block.id === 'string' &&
        typeof row.uuid === 'string'
      ) {
        candidates.push({ id: block.id, uuid: row.uuid, index })
      }
    }
  }
  const pending = candidates.filter((candidate) => !settled.has(candidate.id))
  // PreToolUse receipt order cannot identify two indistinguishable outstanding calls.
  if (
    observation.requiresUniqueInput &&
    (new Set(pending.map((candidate) => candidate.id)).size > 1 ||
      (observation.toolUseId &&
        pending.some((candidate) => candidate.id !== observation.toolUseId)))
  ) {
    return -1
  }
  const id = observation.toolUseId ?? (pending.length === 1 ? pending[0].id : undefined)
  const anchor = candidates.findLast((candidate) => candidate.id === id)
  if (anchor) {
    observation.toolUseId = anchor.id
    observation.descendants.add(anchor.uuid)
    observation.anchored = true
    return anchor.index
  }
  return -1
}

export function readClaudePermissionObservation(observation: ClaudePermissionObservation): void {
  const rows = readJsonlCursor(observation.cursor, undefined, () => {
    observation.anchored = false
    observation.descendants.clear()
    observation.result = false
    observation.verdict = 'working'
  })
  if (!rows) {
    observation.failures++
    return
  }
  observation.failures = 0
  const start = observation.anchored ? 0 : bindRequest(observation, rows) + 1
  if (!observation.anchored) {
    return
  }
  for (const row of rows.slice(start)) {
    if (!rootRecord(row, observation.sessionId) || typeof row.uuid !== 'string') {
      continue
    }
    if (typeof row.parentUuid !== 'string' || !observation.descendants.has(row.parentUuid)) {
      continue
    }
    if (observation.descendants.size >= 512) {
      observation.failures = 3
      return
    }
    if (
      observation.promptId &&
      row.promptId !== undefined &&
      row.promptId !== observation.promptId
    ) {
      continue
    }
    observation.descendants.add(row.uuid)
    const content = blocks(row)
    if (
      row.type === 'user' &&
      content.some(
        (block) => block.type === 'tool_result' && block.tool_use_id === observation.toolUseId
      )
    ) {
      observation.promptId ??= typeof row.promptId === 'string' ? row.promptId : undefined
      observation.result = true
      observation.descendants.clear()
      observation.descendants.add(row.uuid)
    }
    if (!observation.result) {
      continue
    }
    if (
      row.type === 'user' &&
      observation.promptId !== undefined &&
      row.promptId === observation.promptId &&
      content.some(
        (block) =>
          block.type === 'text' && block.text === '[Request interrupted by user for tool use]'
      )
    ) {
      observation.verdict = 'cancellation'
    } else if (
      row.type === 'system' &&
      row.subtype === 'turn_duration' &&
      observation.verdict !== 'cancellation'
    ) {
      observation.verdict = 'done'
    }
  }
}
