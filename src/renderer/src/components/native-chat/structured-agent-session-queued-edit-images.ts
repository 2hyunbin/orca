// A queued edit's images, held in memory for that edit only: the card's own image-ref blocks kept
// verbatim, apart from the images added in this edit. Not the chat box's saved draft, which
// outlives a reload and whose scope keys name a chat, not an edit.

import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import type {
  QueuedMessageEdit,
  QueuedMessageEditResult,
  QueuedMessageImageBlock
} from '../../../../shared/queued-message-edit'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import { stripSentImagePromptMarkers } from '../../../../shared/native-chat-image-transcript-markers'
import { queuedEditSaveReason } from './queued-message-edit-notices'

export type QueuedEditImageState = {
  /** The chat box this edit hands off to; the one it started in, never another. */
  draftKey: string
  originalText: string
  text: string
  kept: readonly { id: string; block: QueuedMessageImageBlock }[]
  /** How many images the card held when the edit began; kept images can only be removed. */
  keptAtStart: number
  added: readonly NativeChatComposerImageAttachment[]
  /** The edit went to the chat box: an upload that settles later follows it there. */
  handedOff: boolean
  intake: QueuedEditImageIntake
}

/** Drives an edit's added images the way an upload or paste drives the chat box's chips. Bound to
 *  one edit, so a late result never lands in another. */
export type QueuedEditImageIntake = {
  begin: (previewUrl?: string, pendingName?: string) => string | null
  resolve: (id: string, path: string, connectionId?: string | null) => boolean
  reveal: (id: string, previewUrl?: string) => void
  /** False once the chip settled or the person removed it, so its file must not attach. */
  drop: (id: string) => boolean
  /** Adds the image paths settled; returns the rest, which are referenced in the text. */
  append: (paths: string[], connectionId?: string | null) => string[]
  remove: (id: string) => void
}

/** What the editor draws and acts on; absent against a host that edits text only. */
export type QueuedEditImagesEditor = {
  chips: NativeChatComposerImageAttachment[]
  intake: QueuedEditImageIntake
  /** Why Save is off, when the person can fix it; a chip still saving shows that itself. */
  reason?: string
}

/** A new edit's images: the card's own, and an intake bound to that edit. */
export function queuedEditImageFields(
  body: AgentJournalMessageItem,
  edit: () => QueuedEditImageState,
  live: () => boolean,
  render: () => void
): Pick<QueuedEditImageState, 'kept' | 'keptAtStart' | 'added' | 'handedOff' | 'intake'> {
  const kept = body.blocks.flatMap((block, index) =>
    block.type === 'image-ref' ? [{ id: `kept-${index}`, block }] : []
  )
  const intake = queuedEditImageIntake(edit, live, render)
  return { kept, keptAtStart: kept.length, added: [], handedOff: false, intake }
}

function imagesChanged(edit: QueuedEditImageState): boolean {
  return edit.kept.length !== edit.keptAtStart || edit.added.length > 0
}

export function queuedEditDirty(edit: QueuedEditImageState): boolean {
  return edit.text !== edit.originalText || imagesChanged(edit)
}

export function queuedEditImagesPending(edit: QueuedEditImageState): boolean {
  return edit.added.some((image) => image.pending)
}

/** What Save writes; the image set only when it changed and the host takes it, so a text-only
 *  Save stays what every host accepts. */
export function queuedEditInput(
  edit: QueuedEditImageState,
  imagesCapable: boolean
): QueuedMessageEdit {
  if (!imagesCapable || !imagesChanged(edit)) {
    return { text: edit.text }
  }
  const added = edit.added.flatMap((image) =>
    image.pending ? [] : [{ type: 'image-ref' as const, path: image.path }]
  )
  return { text: edit.text, images: [...edit.kept.map(({ block }) => block), ...added] }
}

export function queuedEditImagesEditor(
  edit: QueuedEditImageState,
  result: QueuedMessageEditResult
): QueuedEditImagesEditor {
  return {
    chips: [
      ...edit.kept.map(({ id, block }) => ({ id, path: block.path ?? block.url ?? '' })),
      ...edit.added
    ],
    intake: edit.intake,
    ...(result.ok ? {} : { reason: queuedEditSaveReason(result.reason) })
  }
}

function settled(image: NativeChatComposerImageAttachment): NativeChatComposerImageAttachment {
  return {
    id: image.id,
    path: image.path,
    ...(image.connectionId ? { connectionId: image.connectionId } : {})
  }
}

function releasePreview(image: NativeChatComposerImageAttachment): void {
  if (image.previewUrl?.startsWith('blob:')) {
    URL.revokeObjectURL(image.previewUrl)
  }
}

export function releaseQueuedEditImages(edit: QueuedEditImageState): void {
  edit.added.forEach(releasePreview)
}

/** Unsaved typing and additions go to the chat box in one step; true when anything went. The
 *  typing goes without the card's own images, so no marker may name one. */
export function handOffQueuedEdit(edit: QueuedEditImageState): boolean {
  edit.handedOff = true
  const text = edit.text === edit.originalText ? '' : stripSentImagePromptMarkers(edit.text)
  const images = edit.added.flatMap((image) => (image.pending ? [] : [settled(image)]))
  appendNativeChatDraftCache(edit.draftKey, text, undefined, images)
  return text !== '' || edit.added.length > 0
}

function queuedEditImageIntake(
  edit: () => QueuedEditImageState,
  live: () => boolean,
  render: () => void
): QueuedEditImageIntake {
  const update = (added: QueuedEditImageState['added']): void => {
    edit().added = added
    if (live()) {
      render()
    }
  }
  const pendingChip = (id: string) => edit().added.find((image) => image.id === id && image.pending)
  return {
    begin: (previewUrl, pendingName) => {
      if (!live()) {
        return null
      }
      const id = createUuidV4()
      const chip = { id, path: '', pending: true, ...(previewUrl ? { previewUrl } : {}) }
      update([...edit().added, pendingName ? { ...chip, pendingName } : chip])
      return id
    },
    resolve: (id, path, connectionId) => {
      const chip = pendingChip(id)
      if (!chip || !(live() || edit().handedOff)) {
        return false
      }
      const image = settled({ id, path, ...(connectionId ? { connectionId } : {}) })
      if (!live()) {
        appendNativeChatDraftCache(edit().draftKey, '', undefined, [image])
        edit().added = edit().added.filter((entry) => entry !== chip)
        return true
      }
      const previewUrl = chip.previewUrl ? { previewUrl: chip.previewUrl } : {}
      update(edit().added.map((entry) => (entry === chip ? { ...image, ...previewUrl } : entry)))
      return true
    },
    reveal: (id, previewUrl) => {
      if (previewUrl && pendingChip(id)) {
        update(edit().added.map((entry) => (entry.id === id ? { ...entry, previewUrl } : entry)))
      }
    },
    drop: (id) => {
      const chip = pendingChip(id)
      if (chip) {
        releasePreview(chip)
        update(edit().added.filter((entry) => entry !== chip))
      }
      return chip !== undefined
    },
    append: (paths, connectionId) => {
      const images = paths.filter(isNativeChatImageAttachmentPath)
      if (live() && images.length > 0) {
        const link = connectionId ? { connectionId } : {}
        update([...edit().added, ...images.map((path) => ({ id: createUuidV4(), path, ...link }))])
      }
      return paths.filter((path) => !isNativeChatImageAttachmentPath(path))
    },
    remove: (id) => {
      const current = edit()
      current.added.filter((entry) => entry.id === id).forEach(releasePreview)
      current.kept = current.kept.filter((entry) => entry.id !== id)
      update(current.added.filter((entry) => entry.id !== id))
    }
  }
}
