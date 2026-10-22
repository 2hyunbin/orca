import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import { queuedMessageEditableText } from '../../../src/shared/queued-message-edit'
import { promptMarkersToImageReferences } from '../../../src/shared/native-chat-image-transcript-markers'
import { appendMobileNativeChatDraft } from './mobile-native-chat-draft-store'
import { structuredSessionOperationId } from './structured-session-operation-id'

export type MobileQueuedMessageCopy = (message: AgentSessionQueuedMessage) => Promise<boolean>

/** Captures the source draft, retaining references without another upload or sender identity. */
export function copyMobileQueuedMessageToDraft(
  scope: string,
  message: AgentSessionQueuedMessage
): Promise<boolean> {
  const text = queuedMessageEditableText(message.body)
  if (text === null) {
    return Promise.resolve(false)
  }
  const attempt = structuredSessionOperationId()
  const images = message.body.blocks.flatMap((block, index) => {
    if (block.type !== 'image-ref') {
      return []
    }
    const { type: _type, ...reference } = block
    return [
      {
        id: `edit-${attempt}-${index}`,
        path: block.path ?? '',
        reference,
        previewUri: block.url ?? ''
      }
    ]
  })
  return appendMobileNativeChatDraft(scope, {
    text: promptMarkersToImageReferences(
      text,
      images.map((image) => image.id)
    ),
    images,
    skills: message.body.skills
  })
}
