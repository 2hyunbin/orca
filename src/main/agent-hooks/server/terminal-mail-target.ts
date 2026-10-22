import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  readAgentProcessIdentity,
  type AgentProcessIdentity
} from '../../../shared/agent-process-presence'

export type TerminalMailTarget = {
  paneKey: string
  process: AgentProcessIdentity
  owner: string
  turnKey: string
}

export function openTerminalMailTarget(
  row: AgentHookEventPayload | undefined
): TerminalMailTarget | null {
  const turn = row?.hostTurn
  const process = row?.agentPresence?.process
  if (
    !row ||
    row.connectionId !== null ||
    row.restoredUnconfirmed ||
    !process ||
    !turn ||
    turn.currentTurnKey === 'seed' ||
    turn.completed?.turnKey === turn.currentTurnKey ||
    row.payload.mainAgent?.state !== 'working' ||
    row.payload.mainAgent.stopping
  ) {
    return null
  }
  return { paneKey: row.paneKey, process, owner: turn.owner, turnKey: turn.currentTurnKey }
}

export function sameTerminalMailTarget(a: TerminalMailTarget, b: TerminalMailTarget): boolean {
  return (
    a.paneKey === b.paneKey &&
    a.owner === b.owner &&
    a.turnKey === b.turnKey &&
    isSameAgentProcess(a.process, b.process)
  )
}

export function readTerminalMailTarget(value: unknown): TerminalMailTarget | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('paneKey' in value) ||
    typeof value.paneKey !== 'string' ||
    !('owner' in value) ||
    typeof value.owner !== 'string' ||
    !('turnKey' in value) ||
    typeof value.turnKey !== 'string' ||
    !('process' in value)
  ) {
    return null
  }
  const process = readAgentProcessIdentity(value.process)
  return process
    ? { paneKey: value.paneKey, owner: value.owner, turnKey: value.turnKey, process }
    : null
}

export class TerminalMailTargets {
  private readonly abandoned = new Map<string, TerminalMailTarget>()

  read(row: AgentHookEventPayload | undefined): TerminalMailTarget | null {
    return row?.agentPresence?.ended || row?.providerSessionOnly
      ? null
      : openTerminalMailTarget(row)
  }

  observeExit(
    row: AgentHookEventPayload | undefined,
    process: AgentProcessIdentity | undefined
  ): void {
    const target = openTerminalMailTarget(row)
    if (!target || !process || !isSameAgentProcess(target.process, process)) {
      return
    }
    this.abandoned.set(target.paneKey, target)
    if (this.abandoned.size > 256) {
      const oldest = this.abandoned.keys().next().value
      if (oldest !== undefined) {
        this.abandoned.delete(oldest)
      }
    }
  }

  wasAbandoned(
    target: TerminalMailTarget,
    row: AgentHookEventPayload | undefined,
    exit: AgentProcessIdentity | undefined
  ): boolean {
    const turn = row?.hostTurn
    if (row?.payload.mainAgent?.outcome === 'cancellation') {
      return false
    }
    if (
      turn &&
      turn.currentTurnKey !== 'seed' &&
      (turn.owner !== target.owner ||
        turn.currentTurnKey !== target.turnKey ||
        turn.completed?.turnKey === target.turnKey)
    ) {
      return false
    }
    const proof = this.abandoned.get(target.paneKey)
    if (proof && sameTerminalMailTarget(proof, target)) {
      return true
    }
    const retained = openTerminalMailTarget(row)
    return Boolean(
      row?.providerSessionOnly &&
      retained &&
      exit &&
      sameTerminalMailTarget(retained, target) &&
      isSameAgentProcess(exit, target.process)
    )
  }
}
