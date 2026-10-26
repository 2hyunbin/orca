// The seam's watch, as the cloud reads it. Turn ends wait in an owner-only file so a restart still reports them.
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import {
  CONNECTOR_CLIENT_LIMITS,
  type ConnectorConversation,
  type ConnectorEvent
} from '../../shared/connector-cloud-contract'
import { writeSecureJsonFile } from '../../shared/secure-file'
import type {
  ConversationEvent,
  ConversationSnapshot
} from '../external-conversations/external-conversation-events'
import type { ConversationKey } from '../external-conversations/external-conversation-types'
import { isMissingFileError } from '../runtime/device-registry-corruption'
import { ConnectorSendQueue, type ConnectorBatchSender } from './connector-send-queue'

const TURN_OUTBOX_FILE = 'connector-turn-outbox.json'
const MAX_TURN_ENDS = 200
// Live events past this are dropped oldest first; the snapshot after the next session restates them.
const MAX_LIVE_EVENTS = 500
const MAX_EVENTS_PER_REQUEST = 50

type TurnEnded = Extract<ConnectorEvent, { kind: 'turn-ended' }>

const StoredTurnEnds = z.array(
  z.object({
    kind: z.literal('turn-ended'),
    conversation: z.object({ source: z.literal('slack'), externalId: z.string().min(1) }),
    paneKey: z.string().min(1),
    turnId: z.number(),
    at: z.number(),
    stopReason: z.string().min(1).nullable(),
    lastAssistantMessage: z.string().optional()
  })
)

const isTurnEnded = (event: ConnectorEvent): event is TurnEnded => event.kind === 'turn-ended'

function slackConversation(key: ConversationKey): ConnectorConversation | null {
  return key.source === 'slack' ? { source: 'slack', externalId: key.externalId } : null
}

/** Cut on a character boundary so the cloud's byte limit always holds. */
function capUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.byteLength <= maxBytes) {
    return text
  }
  let end = maxBytes
  // Step back over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--
  }
  return bytes.subarray(0, end).toString('utf8')
}

export function toConnectorEvent(
  event: ConversationSnapshot | ConversationEvent
): ConnectorEvent | null {
  if (event.kind === 'snapshot') {
    return {
      kind: 'snapshot',
      conversations: event.conversations.flatMap(
        ({ conversation, paneKey, agent, working, prompt }) => {
          const slack = slackConversation(conversation)
          return slack ? [{ conversation: slack, paneKey, agent, working, prompt }] : []
        }
      )
    }
  }
  const conversation = slackConversation(event.conversation)
  if (!conversation) {
    return null
  }
  const { paneKey } = event
  switch (event.kind) {
    case 'linked':
      return { kind: 'linked', conversation, paneKey, agent: event.agent }
    case 'prompt':
      return { kind: 'prompt', conversation, paneKey, prompt: event.prompt }
    case 'turn-started':
      return { kind: 'turn-started', conversation, paneKey, at: event.at }
    case 'turn-ended':
      // Without its start the cloud cannot place the turn; the next snapshot marks it unverifiable.
      return event.turnId === null
        ? null
        : {
            kind: 'turn-ended',
            conversation,
            paneKey,
            turnId: event.turnId,
            at: event.at,
            stopReason: event.stopReason,
            ...(event.lastAssistantMessage
              ? {
                  lastAssistantMessage: capUtf8(
                    event.lastAssistantMessage,
                    CONNECTOR_CLIENT_LIMITS.maxLastAssistantMessageBytes
                  )
                }
              : {})
          }
  }
}

/** The newest turn ends and live events within their caps, so memory and disk hold the same set. */
function boundEvents(events: ConnectorEvent[]): ConnectorEvent[] {
  const turnEnds = events.filter(isTurnEnded).length
  let turnEndsOver = turnEnds - MAX_TURN_ENDS
  let liveOver = events.length - turnEnds - MAX_LIVE_EVENTS
  if (turnEndsOver <= 0 && liveOver <= 0) {
    return events
  }
  return events.filter((event) => (isTurnEnded(event) ? turnEndsOver-- <= 0 : liveOver-- <= 0))
}

/**
 * Events for the cloud, in order, owned once per linked machine so a replacement client never races
 * a retired one over the file. Turn ends also wait on disk until the cloud accepts them.
 */
export class ConnectorTurnEvents {
  private readonly queue: ConnectorSendQueue<ConnectorEvent>
  private readonly filePath: string

  constructor(userDataPath: string) {
    this.filePath = join(userDataPath, TURN_OUTBOX_FILE)
    this.queue = new ConnectorSendQueue<ConnectorEvent>({
      maxBatch: MAX_EVENTS_PER_REQUEST,
      initial: this.readStored(),
      bound: boundEvents,
      onChange: (events) => this.store(events)
    })
  }

  observe(event: ConversationSnapshot | ConversationEvent): void {
    const wire = toConnectorEvent(event)
    if (wire) {
      this.queue.push(wire)
    }
  }

  /** A new session's snapshot restates everything live, so only turn ends still need sending. */
  newSession(): void {
    this.queue.retain(isTurnEnded)
  }

  attach(sender: ConnectorBatchSender<ConnectorEvent>): void {
    this.queue.attach(sender)
  }

  detach(sender: ConnectorBatchSender<ConnectorEvent>): void {
    this.queue.detach(sender)
  }

  /** Drops everything, file included: no other key can report these turns. */
  clear(): void {
    this.queue.retain(() => false)
  }

  /** The same, before any owner exists in this process. */
  static clearStored(userDataPath: string): void {
    rmSync(join(userDataPath, TURN_OUTBOX_FILE), { force: true })
  }

  private readStored(): TurnEnded[] {
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      if (isMissingFileError(error)) {
        return []
      }
      throw error
    }
    try {
      const parsed = StoredTurnEnds.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : []
    } catch {
      return []
    }
  }

  private store(events: readonly ConnectorEvent[]): void {
    const turnEnds = events.filter(isTurnEnded)
    if (turnEnds.length === 0) {
      rmSync(this.filePath, { force: true })
    } else {
      writeSecureJsonFile(this.filePath, turnEnds)
    }
  }
}
