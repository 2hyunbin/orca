import { useCallback, useEffect, useState } from 'react'
import type { StructuredChatTabNamingFailure } from '@/runtime/structured-conversation-name'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import {
  regenerateStructuredAgentSessionName,
  supportsStructuredAgentSessionRegenerateName
} from '@/runtime/structured-agent-session-client'

export type NativeChatNamingFailureControls = {
  message: string
  /** Known before the card opens: the host check starts when the failure arrives. */
  canRegenerate: boolean
  regenerating: boolean
  regenerate: () => void
  dialogOpen: boolean
  setDialogOpen: (open: boolean) => void
  readFullOutput: () => Promise<string | null>
}

/** What a chat tab offers for its failed name: the error, its dialog, and Regenerate name. */
export function useNativeChatNamingFailure(
  failure: StructuredChatTabNamingFailure | null | undefined
): NativeChatNamingFailureControls | null {
  const executionHostId = failure?.executionHostId ?? null
  const sessionId = failure?.sessionId
  const failedAt = failure?.error.failedAt
  // Keyed by host so a tab moved to another host never shows the old host's answer.
  const [support, setSupport] = useState<{ host: string | null; ok: boolean } | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  // A click's run is still owed while the failure it answered is still the one shown.
  const [regeneratingFor, setRegeneratingFor] = useState<number | null>(null)
  const failing = failure !== null && failure !== undefined
  useEffect(() => {
    const target = failing ? structuredAgentSessionTargetForHost(executionHostId) : null
    if (!target) {
      return
    }
    let live = true
    void supportsStructuredAgentSessionRegenerateName(target).then((ok) => {
      if (live) {
        setSupport({ host: executionHostId, ok })
      }
    })
    return () => {
      live = false
    }
  }, [executionHostId, failing])
  const regenerate = useCallback(() => {
    const target = structuredAgentSessionTargetForHost(executionHostId)
    if (!target || !sessionId || failedAt === undefined) {
      return
    }
    setRegeneratingFor(failedAt)
    void regenerateStructuredAgentSessionName(target, sessionId).then((accepted) => {
      if (!accepted) {
        setRegeneratingFor((current) => (current === failedAt ? null : current))
      }
    })
  }, [executionHostId, failedAt, sessionId])
  const readFullOutput = useCallback(async () => {
    // The full output never leaves the host that ran the agent; a paired one shows the message.
    const local = structuredAgentSessionTargetForHost(executionHostId)?.kind === 'local'
    return local && sessionId
      ? window.api.nativeChat.getConversationNameFailureOutput(sessionId)
      : null
  }, [executionHostId, sessionId])
  if (!failure) {
    return null
  }
  return {
    message: failure.error.message,
    canRegenerate: support?.host === executionHostId && support.ok,
    regenerating: regeneratingFor === failedAt,
    regenerate,
    dialogOpen,
    setDialogOpen,
    readFullOutput
  }
}
