import { useCallback } from 'react'
import type { StructuredAgentId } from '../../../src/shared/agent-session-provider-handle'
import { isStructuredAgentSessionComposerCommand } from '../../../src/shared/structured-agent-session-composer'
import type {
  MobileNativeChatSendChoice,
  MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'

type StructuredNativeChatAttachment = {
  id?: string
  path: string
  previewUri: string
}

export function useMobileStructuredNativeChatSendBridge(args: {
  agent: StructuredAgentId | undefined
  sendStructured: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredNativeChatAttachment[],
    choice?: MobileNativeChatSendChoice
  ) => Promise<MobileNativeChatSendOutcome>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  onSendError: (message: string) => void
}): {
  send: (text: string, images?: string[]) => Promise<boolean>
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredNativeChatAttachment[],
    choice?: MobileNativeChatSendChoice
  ) => Promise<MobileNativeChatSendOutcome>
} {
  const {
    agent,
    captureSendOrigin,
    clearDraftForSend,
    onSendError,
    restoreRejectedDraft,
    sendStructured
  } = args
  const sendWithOutcome = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredNativeChatAttachment[],
      choice?: MobileNativeChatSendChoice
    ): Promise<MobileNativeChatSendOutcome> => {
      const origin = captureSendOrigin(text.trimEnd())
      if (!origin) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      const isHostCommand = isStructuredAgentSessionComposerCommand(text, agent)
      clearDraftForSend(origin, text)
      const outcome =
        choice !== undefined
          ? await sendStructured(text, images, deadline, attachments, choice)
          : attachments !== undefined
            ? await sendStructured(text, images, deadline, attachments)
            : deadline !== undefined
              ? await sendStructured(text, images, deadline)
              : images !== undefined
                ? await sendStructured(text, images)
                : await sendStructured(text)
      // The structured session draws or holds a message the host took; a command's lost answer
      // comes back instead.
      if (outcome === 'rejected' || (outcome === 'unknown' && isHostCommand)) {
        restoreRejectedDraft(origin, text)
      }
      return outcome
    },
    [agent, captureSendOrigin, clearDraftForSend, onSendError, restoreRejectedDraft, sendStructured]
  )
  const send = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredNativeChatAttachment[],
      choice?: MobileNativeChatSendChoice
    ) => (await sendWithOutcome(text, images, deadline, attachments, choice)) !== 'rejected',
    [sendWithOutcome]
  )
  return { send, sendWithOutcome }
}
