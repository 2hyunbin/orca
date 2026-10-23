import {
  NativeChatViewIdentity,
  createNativeChatReturnField,
  useNativeChatReturnRef,
  retireNativeChatViewState
} from './native-chat-view-state-memory'
import { useContext, useEffect, useMemo } from 'react'
import { extractPendingMessageReplyAsk, formatAskAnswer } from '../../../../shared/native-chat-ask'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { useNativeChatPromptCardPresentation } from './use-native-chat-prompt-card-presentation'

/**
 * A question the agent asked without waiting (Codex's async one), pending until the next user
 * message. It sits above the composer rather than in its place, since the agent keeps working:
 * it is answered by an ordinary send, and Cancel only hides it.
 */
const previousQuestion = createNativeChatReturnField<string | null>()

export function NativeChatStructuredAsyncQuestion({
  paneKey,
  session,
  send
}: {
  paneKey: string
  session: Pick<NativeChatLiveSession, 'messages' | 'readPhase'>
  send: NativeChatStructuredComposerTransport['send']
}): React.JSX.Element | null {
  const view = useContext(NativeChatViewIdentity)
  const settled = session.readPhase === 'ready'
  const pending = useMemo(() => {
    const prompt = settled ? extractPendingMessageReplyAsk(session.messages) : null
    return prompt ? { kind: 'question' as const, prompt } : null
  }, [session.messages, settled])
  const presentation = useNativeChatPromptCardPresentation({
    paneKey,
    card: pending,
    canSend: true,
    transcriptSettled: settled
  })
  const identity = view === null ? null : `${view}\0async-question:${presentation.occurrenceKey}`
  const previous = useNativeChatReturnRef(previousQuestion, () => null)
  useEffect(() => {
    if (!settled) {
      return
    }
    if (previous.current && previous.current !== identity) {
      retireNativeChatViewState(previous.current)
    }
    previous.current = identity
  }, [identity, previous, settled])
  const { card } = presentation
  if (card?.kind !== 'question') {
    return null
  }
  return (
    <NativeChatViewIdentity.Provider value={identity}>
      <NativeChatQuestionCard
        key={presentation.occurrenceKey ?? 'async-question'}
        prompt={card.prompt}
        onAnswer={(selections) => {
          if (send(formatAskAnswer(card.prompt, selections), []) !== false) {
            presentation.dismiss()
          }
        }}
        onCancel={presentation.dismiss}
      />
    </NativeChatViewIdentity.Provider>
  )
}
