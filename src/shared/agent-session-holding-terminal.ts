export type AgentSessionHoldingTerminal = { paneKey: string; worktreeId: string }

export function readAgentSessionHoldingTerminal(
  value: unknown
): AgentSessionHoldingTerminal | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'paneKey' in value &&
    'worktreeId' in value &&
    typeof value.paneKey === 'string' &&
    value.paneKey.trim() &&
    typeof value.worktreeId === 'string' &&
    value.worktreeId.trim()
    ? { paneKey: value.paneKey, worktreeId: value.worktreeId }
    : undefined
}

export function readAgentSessionRefusalHoldingTerminal(
  code: string,
  value: Record<string, unknown>
): AgentSessionHoldingTerminal | undefined {
  return !value.owner &&
    ((code === 'agent_session_conflict' && value.reason === 'conversationHeldElsewhere') ||
      (code === 'agent_session_operation_invalid' && value.reason === 'conversationOpenInTerminal'))
    ? readAgentSessionHoldingTerminal(value.terminal)
    : undefined
}
