// Keys typed into an agent pane before its PTY binds would land ahead of the launch line, so they
// are kept as an unsubmitted draft and pasted once the agent is ready.

import { useAppStore } from '@/store'
import { TUI_AGENT_CONFIG } from '../../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import { resolveDraftPasteReadyTimeoutMs } from '../../../../../shared/draft-paste-ready-timeout'
import { waitForAgentDraftInputReady } from '@/lib/agent-draft-readiness'
import { sendAgentDraftPasteContent } from '@/lib/agent-draft-paste-content'
import { createPasteReadinessTimeoutNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { PTY_PRECONNECT_INPUT_MAX_CODE_UNITS } from '../pty-preconnect-input-buffer'
import { writeTerminalPastePtyInput } from '../terminal-pty-paste-writer'
import { findColdRestoreResumeSource } from './cold-restore-resume-startup'
import { paneHasStartupWork } from './pane-transport-options'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const BACKSPACE = '\x7f'
const CTRL_H = '\b'

/**
 * Adds typed bytes to a draft: printable text only. Enter, Tab, other control keys and escape
 * sequences are dropped so nothing submits or edits; Backspace deletes the last character.
 */
export function appendTypedDraftText(draft: string, data: string, maxCodeUnits: number): string {
  if (data.startsWith('\x1b')) {
    return draft
  }
  let next = draft
  for (const char of data) {
    if (char === BACKSPACE || char === CTRL_H) {
      next = Array.from(next).slice(0, -1).join('')
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
      continue
    }
    if (next.length + char.length > maxCodeUnits) {
      break
    }
    next += char
  }
  return next
}

type DraftPhase = 'capturing' | 'delivering' | 'closed'

export function installAgentPreReadyTypedDraft(session: ConnectPanePtySession): void {
  let phase: DraftPhase = 'capturing'
  let draft = ''
  let agent: TuiAgent | null | undefined

  const resolveAgent = (): TuiAgent | null => {
    if (agent === undefined) {
      const state = useAppStore.getState()
      agent =
        !session.transportOptions?.bufferInputUntilConnect && paneHasStartupWork(session)
          ? ((session.paneStartup
              ? (session.startupDraftAgent ?? session.resolveExpectedLaunchTuiAgent())
              : null) ??
            findColdRestoreResumeSource(session, state)?.agent ??
            null)
          : null
    }
    return agent ?? null
  }

  // Why seeded: a deferred split with agent startup used to flush handed-off keys at bind.
  for (const entry of session.deps.preconnectInput ?? []) {
    if (entry.inputKind === 'driving' && resolveAgent()) {
      draft = appendTypedDraftText(draft, entry.data, PTY_PRECONNECT_INPUT_MAX_CODE_UNITS)
    }
  }

  session.captureAgentPreReadyInput = (data: string, wasUserInput: boolean): boolean => {
    if (phase === 'closed' || !resolveAgent()) {
      return false
    }
    const bound = session.transport.getPtyId() !== null
    if (bound && phase === 'capturing' && draft === '') {
      // Nothing was typed before the bind: live input keeps today's path.
      phase = 'closed'
      return false
    }
    if (!wasUserInput) {
      // Pre-bind focus reports have no terminal to reach; after a bind they keep their path.
      return !bound
    }
    // Why after a bind too: later keys must not overtake the held draft.
    draft = appendTypedDraftText(draft, data, PTY_PRECONNECT_INPUT_MAX_CODE_UNITS)
    return true
  }

  const pasteDraft = async (ptyId: string): Promise<void> => {
    const text = draft
    draft = ''
    phase = 'closed'
    if (!text || session.disposed || session.transport.getPtyId() !== ptyId) {
      return
    }
    // Why merge: a launch-time draft not yet pasted sends both as one, in typing order.
    if (session.ownsStartupDraftPaste && !session.startupDraftPasteAttempted) {
      session.startupDraftPrompt = joinDraftText(session.startupDraftPrompt, text)
      return
    }
    await sendAgentDraftPasteContent(ptyId, text, 'driving', (data) =>
      writeTerminalPastePtyInput(session.transport, data, 'driving')
    ).catch(() => false)
  }

  session.onAgentPreReadyDraftPtyBound = (ptyId: string, freshSpawn: boolean): void => {
    const draftAgent = agent
    if (phase !== 'capturing' || !draftAgent) {
      return
    }
    if (draft === '') {
      phase = 'closed'
      return
    }
    phase = 'delivering'
    if (!freshSpawn) {
      // A reattached agent is already running; its composer takes the draft now.
      void pasteDraft(ptyId)
      return
    }
    void waitForAgentDraftInputReady(
      ptyId,
      resolveDraftPasteReadyTimeoutMs(draftAgent),
      TUI_AGENT_CONFIG[draftAgent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
    ).then((ready) => {
      if (ready) {
        void pasteDraft(ptyId)
        return
      }
      const dropped = draft !== ''
      draft = ''
      phase = 'closed'
      if (dropped && !session.disposed) {
        createPasteReadinessTimeoutNotice({
          worktreeId: session.deps.worktreeId,
          tabId: session.deps.tabId,
          agent: draftAgent,
          submitted: false
        }).onTimeout()
      }
    })
  }

  session.discardAgentPreReadyDraft = (): void => {
    draft = ''
    phase = 'closed'
  }
}

function joinDraftText(existing: string | null, typed: string): string {
  if (!existing) {
    return typed
  }
  return /\s$/.test(existing) ? `${existing}${typed}` : `${existing} ${typed}`
}
