import {
  readTerminalMailTarget,
  type TerminalMailTarget
} from '../../agent-hooks/server/terminal-mail-target'

export type TerminalMailHandoff = {
  version: 1
  kind: 'terminal'
  id: string
  authority: string
  phase: 'reserved' | 'offered'
  target: TerminalMailTarget | null
  recoverySource?: TerminalMailTarget
}

export type StructuredMailHandoff = {
  version: 1
  kind: 'structured'
  sessionId: string
  epoch: string
  operationId: string
  clientMessageId: string
  phase: 'reserved' | 'offered'
  authorizationId: string
  frontier: string
  nonAdmission?: 'refused' | 'expired'
  recoverySource?: string
  authority: string
}

export type AutomaticMailHandoff = StructuredMailHandoff | TerminalMailHandoff
export type MailHandoff = AutomaticMailHandoff | { version: 1; kind: 'unknown' }

export const UNKNOWN_MAIL_HANDOFF = JSON.stringify({ version: 1, kind: 'unknown' })

export function readMailHandoff(value: string | null | undefined): MailHandoff | null {
  if (value == null) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      parsed.version === 1 &&
      'kind' in parsed &&
      parsed.kind === 'terminal' &&
      'id' in parsed &&
      typeof parsed.id === 'string' &&
      'authority' in parsed &&
      typeof parsed.authority === 'string' &&
      'phase' in parsed &&
      (parsed.phase === 'reserved' || parsed.phase === 'offered') &&
      'target' in parsed
    ) {
      const target = readTerminalMailTarget(parsed.target)
      const source =
        'recoverySource' in parsed ? readTerminalMailTarget(parsed.recoverySource) : null
      return {
        version: 1,
        kind: 'terminal',
        id: parsed.id,
        authority: parsed.authority,
        phase: parsed.phase,
        target,
        ...(source ? { recoverySource: source } : {})
      }
    }
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      parsed.version === 1 &&
      'kind' in parsed &&
      parsed.kind === 'structured' &&
      'sessionId' in parsed &&
      typeof parsed.sessionId === 'string' &&
      'epoch' in parsed &&
      typeof parsed.epoch === 'string' &&
      'operationId' in parsed &&
      typeof parsed.operationId === 'string' &&
      'clientMessageId' in parsed &&
      typeof parsed.clientMessageId === 'string' &&
      'phase' in parsed &&
      (parsed.phase === 'reserved' || parsed.phase === 'offered') &&
      'authority' in parsed &&
      typeof parsed.authority === 'string' &&
      'authorizationId' in parsed &&
      typeof parsed.authorizationId === 'string' &&
      'frontier' in parsed &&
      typeof parsed.frontier === 'string'
    ) {
      return {
        version: 1,
        kind: 'structured',
        sessionId: parsed.sessionId,
        epoch: parsed.epoch,
        operationId: parsed.operationId,
        clientMessageId: parsed.clientMessageId,
        phase: parsed.phase,
        authorizationId: parsed.authorizationId,
        frontier: parsed.frontier,
        ...('nonAdmission' in parsed &&
        (parsed.nonAdmission === 'refused' || parsed.nonAdmission === 'expired')
          ? { nonAdmission: parsed.nonAdmission }
          : {}),
        ...('recoverySource' in parsed && typeof parsed.recoverySource === 'string'
          ? { recoverySource: parsed.recoverySource }
          : {}),
        authority: parsed.authority
      }
    }
  } catch {
    /* Unreadable ownership is unknown, never fresh. */
  }
  return { version: 1, kind: 'unknown' }
}
