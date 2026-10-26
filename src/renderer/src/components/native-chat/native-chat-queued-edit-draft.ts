import type { JSONContent } from '@tiptap/react'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import { imageReferenceToken } from '../../../../shared/native-chat-image-reference'
import {
  imageReferencesToPromptMarkers,
  promptMarkersToImageReferences
} from '../../../../shared/native-chat-image-transcript-markers'
import {
  queuedEditKeptImages,
  queuedMessageEditableText,
  type QueuedMessageEdit
} from '../../../../shared/queued-message-edit'
import { pickedSkillsInText } from '../../../../shared/structured-agent-session-send-mutation'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import { promptSkillRefs } from './native-chat-prompt-document'
import { promptTextContent, withoutImageReferenceNodes } from './native-chat-prompt-document-text'
import {
  appendToNativeChatComposerDraft,
  redirectNativeChatEditDraft,
  closeNativeChatEditDraft,
  openNativeChatEditDraft,
  readNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import {
  clearNativeChatPendingAttachments,
  moveNativeChatPendingAttachments,
  nativeChatImageRow,
  nativeChatPendingAttachmentSnapshot
} from './native-chat-pending-attachment-cache'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'
import {
  nativeChatPastedTextAdmission,
  resolveNativeChatPastedText
} from './native-chat-composer-pasted-text-references'
import type { NativeChatComposerDraft } from './native-chat-composer-draft-storage'

function seedSkills(node: JSONContent, body: AgentJournalMessageItem): JSONContent {
  if (node.type === 'text' && node.text) {
    return node
  }
  return {
    ...node,
    content: node.content?.flatMap((child) => {
      if (child.type !== 'text' || !child.text) {
        return [seedSkills(child, body)]
      }
      const pieces: JSONContent[] = []
      const text = child.text
      let start = 0
      const pattern = /\$[\w:-]+/gu
      for (const match of text.matchAll(pattern)) {
        const skill = body.skills?.find(({ name }) => `$${name}` === match[0])
        if (!skill) {
          continue
        }
        if (match.index > start) {
          pieces.push({ type: 'text', text: text.slice(start, match.index) })
        }
        pieces.push({ type: 'nativeChatSkill', attrs: { token: match[0], path: skill.path } })
        start = match.index + match[0].length
      }
      if (start < text.length) {
        pieces.push({ type: 'text', text: text.slice(start) })
      }
      return pieces
    })
  }
}

export type NativeChatQueuedEditDraft = {
  scopeKey: string
  destination: string
  body: AgentJournalMessageItem
  initial: NativeChatComposerDraft
  kept: ReturnType<typeof queuedEditKeptImages>
}

export function createNativeChatQueuedEditDraft(
  body: AgentJournalMessageItem,
  destination: string
): NativeChatQueuedEditDraft {
  const scopeKey = `queued-edit:${createUuidV4()}`
  const kept = queuedEditKeptImages(body)
  const text = promptMarkersToImageReferences(
    queuedMessageEditableText(body) ?? '',
    kept.map(({ id }) => id)
  )
  const initial: NativeChatComposerDraft = {
    text,
    document: seedSkills(promptTextContent(text), body),
    images: kept.map(({ id, block }) => ({ id, path: block.path ?? block.url ?? '' }))
  }
  openNativeChatEditDraft(scopeKey, initial)
  return { scopeKey, destination, body, initial, kept }
}

export function nativeChatQueuedEditInput(
  edit: NativeChatQueuedEditDraft,
  imagesCapable: boolean,
  skillsCapable: boolean
): QueuedMessageEdit {
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  const text = imageReferencesToPromptMarkers(
    resolveNativeChatPastedText(edit.scopeKey, draft.text),
    draft.images.map(({ id }) => id)
  )
  const images = draft.images.map(
    (image) =>
      edit.kept.find(({ id }) => id === image.id)?.block ?? {
        type: 'image-ref' as const,
        path: image.path
      }
  )
  return {
    text,
    ...(imagesCapable ? { images } : {}),
    ...(skillsCapable ? { skills: pickedSkillsInText(text, promptSkillRefs(draft.document)) } : {})
  }
}

export function nativeChatQueuedEditDirty(edit: NativeChatQueuedEditDraft): boolean {
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  return (
    draft.text !== edit.initial.text ||
    JSON.stringify(draft.images) !== JSON.stringify(edit.initial.images) ||
    JSON.stringify(pickedSkillsInText(draft.text, promptSkillRefs(draft.document))) !==
      JSON.stringify(pickedSkillsInText(edit.initial.text, edit.body.skills ?? [])) ||
    nativeChatPendingAttachmentSnapshot(edit.scopeKey).length > 0
  )
}

export function nativeChatQueuedEditHeld(
  edit: NativeChatQueuedEditDraft,
  imagesCapable: boolean
): boolean {
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  return (
    nativeChatPendingAttachmentSnapshot(edit.scopeKey).some(({ pending }) => pending) ||
    nativeChatPastedTextAdmission(edit.scopeKey) !== null ||
    (!imagesCapable && JSON.stringify(draft.images) !== JSON.stringify(edit.initial.images)) ||
    draft.images.some(({ unavailableName }) => unavailableName !== undefined)
  )
}

/** Move only draft-owned additions; card-owned images remain with the accepted message. */
export function handBackNativeChatQueuedEdit(edit: NativeChatQueuedEditDraft): boolean {
  if (!nativeChatQueuedEditDirty(edit)) {
    return false
  }
  const draft = readNativeChatComposerDraft(edit.scopeKey)
  let text = draft.text
  let document = draft.document
  for (const { id } of edit.kept) {
    text = text.replaceAll(imageReferenceToken(id), '')
    if (document) {
      document = withoutImageReferenceNodes(document, id)
    }
  }
  const textChanged =
    draft.text !== edit.initial.text ||
    JSON.stringify(pickedSkillsInText(draft.text, promptSkillRefs(draft.document))) !==
      JSON.stringify(pickedSkillsInText(edit.initial.text, edit.body.skills ?? []))
  if (!textChanged) {
    text = ''
    document = undefined
  }
  const images = draft.images.filter(({ id }) => !edit.kept.some((kept) => kept.id === id))
  const pending = nativeChatPendingAttachmentSnapshot(edit.scopeKey)
  // Pending markers still belong to the returned draft even if all other text stayed unchanged.
  if (!textChanged) {
    text = nativeChatImageRow(images, pending)
      .map(({ id }) => imageReferenceToken(id))
      .join(' ')
  }
  appendToNativeChatComposerDraft(edit.destination, {
    text,
    document,
    images,
    pastedTextFiles: draft.pastedTextFiles
  })
  redirectNativeChatEditDraft(edit.scopeKey, edit.destination)
  moveNativeChatPendingAttachments(edit.scopeKey, edit.destination)
  for (const operation of nativeChatPastedTextOperations.values()) {
    if (operation.scopeKey === edit.scopeKey) {
      operation.scopeKey = edit.destination
    }
  }
  return text !== '' || images.length > 0 || pending.length > 0
}

export function discardNativeChatQueuedEdit(edit: NativeChatQueuedEditDraft): void {
  clearNativeChatPendingAttachments(edit.scopeKey)
  closeNativeChatEditDraft(edit.scopeKey)
}
