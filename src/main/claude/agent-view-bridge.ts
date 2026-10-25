import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { claudeAgentViewChord } from './agent-view-keybindings'
import {
  CLAUDE_AGENT_VIEW_SHORTCUTS,
  type ClaudeAgentViewResult
} from '../../shared/claude-agent-view'

const Identity = z.object({
  paneKey: z
    .string()
    .max(256)
    .refine((value) => parsePaneKey(value) !== null),
  sessionId: z.string().min(1).max(256),
  instanceId: z.string().min(1).max(256)
})
const Message = z.discriminatedUnion('action', [
  Identity.extend({ action: z.literal('register'), keybindings: z.string().max(128 * 1024) }),
  Identity.extend({ action: z.literal('take') }),
  Identity.extend({
    action: z.literal('ack'),
    requestId: z.string().max(64),
    deny: z.string().max(1024).optional()
  }),
  Identity.extend({ action: z.literal('end') })
])

type PendingView = {
  requestId: string
  agentId?: string
  expiresAt: number
  taken: boolean
  finish: (result: ClaudeAgentViewResult) => void
}

type ViewSession = z.infer<typeof Identity> & {
  chord: string
  seenAt: number
  pending?: PendingView
}

type BridgeReply = { registered?: true; requestId?: string; agentId?: string; expiresAt?: number }

export class ClaudeAgentViewBridge {
  private readonly sessions = new Map<string, ViewSession>()

  receive(body: unknown): BridgeReply {
    const parsed = Message.safeParse(body)
    if (!parsed.success) {
      return {}
    }
    const message = parsed.data
    const current = this.sessions.get(message.paneKey)
    if (message.action === 'register') {
      const chord = claudeAgentViewChord(message.keybindings)
      if (!chord) {
        if (current?.instanceId === message.instanceId && current.sessionId === message.sessionId) {
          current.pending?.finish({ status: 'unavailable' })
          this.sessions.delete(message.paneKey)
        }
        return {}
      }
      this.prune()
      if (!current && this.sessions.size >= 1024) {
        return {}
      }
      if (current?.instanceId === message.instanceId && current.sessionId === message.sessionId) {
        current.seenAt = Date.now()
        current.chord = chord
      } else {
        current?.pending?.finish({ status: 'unavailable' })
        this.sessions.set(message.paneKey, {
          paneKey: message.paneKey,
          sessionId: message.sessionId,
          instanceId: message.instanceId,
          chord,
          seenAt: Date.now()
        })
      }
      return { registered: true }
    }
    if (
      !current ||
      current.instanceId !== message.instanceId ||
      current.sessionId !== message.sessionId
    ) {
      return {}
    }
    if (message.action === 'end') {
      current.pending?.finish({ status: 'unavailable' })
      this.sessions.delete(message.paneKey)
      return {}
    }
    const request = current.pending
    if (!request) {
      return {}
    }
    if (message.action === 'take') {
      if (request.taken || request.expiresAt < Date.now()) {
        return {}
      }
      request.taken = true
      return {
        requestId: request.requestId,
        agentId: request.agentId,
        expiresAt: request.expiresAt
      }
    }
    if (request.taken && message.requestId === request.requestId) {
      request.finish(
        message.deny ? { status: 'denied', reason: message.deny } : { status: 'viewed' }
      )
    }
    return {}
  }

  async view(args: {
    paneKey: string
    sessionId: string
    agentId?: string
    trigger: (input: string, isCurrent: () => boolean) => Promise<boolean>
    signal?: AbortSignal
  }): Promise<ClaudeAgentViewResult> {
    this.prune()
    const session = this.sessions.get(args.paneKey)
    const shortcut = CLAUDE_AGENT_VIEW_SHORTCUTS.find((item) => item.chord === session?.chord)
    if (!session || session.sessionId !== args.sessionId || !shortcut) {
      return { status: 'unsupported' }
    }
    if (session.pending) {
      return { status: 'busy' }
    }
    if (args.signal?.aborted) {
      return { status: 'unavailable' }
    }
    let finish: (result: ClaudeAgentViewResult) => void = () => {}
    const answer = new Promise<ClaudeAgentViewResult>((resolve) => {
      finish = resolve
    })
    const pending: PendingView = {
      requestId: randomUUID(),
      agentId: args.agentId,
      expiresAt: Date.now() + 1500,
      taken: false,
      finish
    }
    session.pending = pending
    const isCurrent = () =>
      !args.signal?.aborted &&
      this.sessions.get(args.paneKey) === session &&
      session.chord === shortcut.chord &&
      session.pending === pending &&
      pending.expiresAt >= Date.now() &&
      Date.now() - session.seenAt <= 15000
    const timeout = setTimeout(() => finish({ status: 'timeout' }), 5500)
    const abort = () => finish({ status: 'unavailable' })
    args.signal?.addEventListener('abort', abort, { once: true })
    try {
      if (!(await args.trigger(shortcut.input, isCurrent))) {
        return { status: 'unavailable' }
      }
      return await answer
    } finally {
      clearTimeout(timeout)
      args.signal?.removeEventListener('abort', abort)
      if (session.pending === pending) {
        session.pending = undefined
      }
    }
  }

  clear(): void {
    for (const session of this.sessions.values()) {
      session.pending?.finish({ status: 'unavailable' })
    }
    this.sessions.clear()
  }

  private prune(): void {
    for (const [paneKey, session] of this.sessions) {
      if (Date.now() - session.seenAt > 15000) {
        session.pending?.finish({ status: 'unavailable' })
        this.sessions.delete(paneKey)
      }
    }
  }
}
