import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  keysMayMatch,
  terminalConversationKey,
  type ConversationKey
} from '../native-chat/structured-conversation-key'

/** A terminal start of a conversation Orca issued itself, which a chat's agent start must not race. */
export type ManagedConversationStart = {
  /** Ties the start to the PTY execution running it; until then it holds unconditionally. */
  bind: (ptyId: string, incarnationId: PtyIncarnationId | null) => void
  drop: () => void
}

export type ManagedStartPty = Pick<
  RuntimePtyWorktreeRecord,
  'incarnationId' | 'cliConversations'
> & {
  exited: boolean
}

type Entry = {
  keys: readonly ConversationKey[]
  pty: { ptyId: string; incarnationId: PtyIncarnationId | null } | null
}

/**
 * In memory only: a host restart loses every entry, and a restored pane then goes through the
 * automatic-home guard instead. No timer ends an entry; only re-derived truth does: its terminal's
 * hooks reported the conversation (the census takes over), or its PTY execution is gone.
 */
export class ManagedConversationStarts {
  private readonly entries = new Set<Entry>()

  /** Synchronous, so a caller's admission check and this registration are one step. */
  reserve(keys: readonly ConversationKey[]): ManagedConversationStart {
    const entry: Entry = { keys, pty: null }
    this.entries.add(entry)
    return {
      bind: (ptyId, incarnationId) => {
        if (this.entries.has(entry)) {
          entry.pty = { ptyId, incarnationId }
        }
      },
      drop: () => {
        this.entries.delete(entry)
      }
    }
  }

  /** Whether a managed start may still be writing `key`'s conversation; ends those that can't. */
  live(key: ConversationKey, readPty: (ptyId: string) => ManagedStartPty | null): boolean {
    let live = false
    for (const entry of this.entries) {
      if (entry.pty && ended(entry, readPty(entry.pty.ptyId))) {
        this.entries.delete(entry)
      } else if (entry.keys.some((held) => keysMayMatch(held, key))) {
        live = true
      }
    }
    return live
  }
}

function ended(entry: Entry, pty: ManagedStartPty | null): boolean {
  if (!pty || pty.exited || pty.incarnationId !== entry.pty?.incarnationId) {
    return true
  }
  const reported =
    pty.cliConversations?.incarnationId === pty.incarnationId
      ? [...pty.cliConversations.byKey.values()]
      : []
  return reported.some((conversation) =>
    entry.keys.some((held) =>
      keysMayMatch(terminalConversationKey(conversation.agent, conversation.id), held)
    )
  )
}
