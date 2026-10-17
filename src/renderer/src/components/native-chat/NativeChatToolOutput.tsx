import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { formatBytes } from '@/components/status-bar/workspace-space-format'
import {
  readStructuredAgentSessionItem,
  supportsStructuredAgentSessionItemDetail
} from '@/runtime/structured-agent-session-client'
import type {
  AgentJournalBoundedPayload,
  AgentJournalItemBody
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatToolResultBlock } from '../../../../shared/native-chat-types'
import { MAX_TOOL_DETAIL_LENGTH } from '../../../../shared/native-chat-tool-summary'
import { useNativeChatVisualOwner } from './native-chat-visual-owner'
import { truncateToolDetail } from './native-chat-tool-summary'

/** `partial`: Orca kept only part of this output (past its storage ceiling) or the item was more
 *  than one reply carries. */
type FullOutput = { text: string; partial: { shown: number; total: number } | null }

function fullPayload(body: AgentJournalItemBody): AgentJournalBoundedPayload | null {
  if (body.kind === 'tool-call') {
    return body.output ?? null
  }
  return body.kind === 'diff' ? body.patch : null
}

/** A tool's output in an opened row: a head of it, and the whole of it on request, read from the
 *  host that keeps it. State is the row's own, so a live revision never fights it. */
export function NativeChatToolOutput({
  body
}: {
  body: NativeChatToolResultBlock
}): React.JSX.Element {
  const owner = useNativeChatVisualOwner()
  const [full, setFull] = useState<FullOutput | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const clipped =
    full === null &&
    (body.fullOutputItemId !== undefined || body.output.length > MAX_TOOL_DETAIL_LENGTH)

  const showFull = async (): Promise<void> => {
    const itemId = body.fullOutputItemId
    if (itemId === undefined || owner === null) {
      setFull({ text: body.output, partial: null })
      return
    }
    setLoading(true)
    setFailed(false)
    try {
      // An older host keeps only the head it already sent.
      const item = (await supportsStructuredAgentSessionItemDetail(owner.target))
        ? await readStructuredAgentSessionItem(owner.target, owner.sessionId, itemId)
        : null
      const payload = item ? fullPayload(item.body) : null
      setFull(
        payload
          ? {
              text: payload.head,
              partial: payload.truncated
                ? { shown: new TextEncoder().encode(payload.head).length, total: payload.byteLength }
                : null
            }
          : { text: body.output, partial: null }
      )
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-1">
      <pre
        data-native-chat-code-content
        className={cn(
          'max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-chat-code-border bg-chat-code-surface p-2 font-mono text-chat-code scrollbar-sleek',
          body.isError ? 'text-destructive' : 'text-chat-foreground'
        )}
      >
        {full ? full.text : truncateToolDetail(body.output)}
      </pre>
      {full?.partial ? (
        <p className="text-xs text-chat-foreground-faint">
          {translate(
            'components.native-chat.tool.fullOutputPartial',
            'Showing {{shown}} of {{total}}.',
            { shown: formatBytes(full.partial.shown), total: formatBytes(full.partial.total) }
          )}
        </p>
      ) : null}
      {clipped ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={loading}
            onClick={() => void showFull()}
          >
            {translate('components.native-chat.tool.showFullOutput', 'Show full output')}
          </Button>
          {failed ? (
            <span className="text-xs text-chat-foreground-faint">
              {translate(
                'components.native-chat.tool.fullOutputFailed',
                "Couldn't load the full output."
              )}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
