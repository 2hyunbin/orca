// A queued edit's images, held in memory for that edit only: the card's own image-ref blocks kept
// verbatim, apart from the images added in this edit. Not the chat box's saved draft, which
// outlives a reload and whose scope keys name a chat, not an edit.

import type { AgentJournalMessageItem } from '../../../../shared/agent-session-journal-types'
import {
  queuedEditBaseText,
  queuedEditImagesPending,
  queuedEditKeptImages,
  queuedEditTextForKeptImages,
  queuedEditTextWithAddedImages,
  type QueuedEditImageSelection,
  type QueuedMessageEditResult,
  type QueuedMessageImageBlock
} from '../../../../shared/queued-message-edit'
import { createUuidV4 } from '../../../../shared/uuid-v4'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { appendNativeChatDraftCache } from './native-chat-draft-cache'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import { formatNativeChatFileReference } from '../../../../shared/agent-image-paste'
import {
  promptMarkersToImageReferences,
  stripSentImagePromptMarkers
} from '../../../../shared/native-chat-image-transcript-markers'

export type QueuedEditImageState = {
  /** The chat box this edit hands off to; the one it started in, never another. */
  draftKey: string
  body: AgentJournalMessageItem
  text: string
  kept: readonly { id: string; block: QueuedMessageImageBlock }[]
  added: readonly NativeChatComposerImageAttachment[]
  intake: QueuedEditImageIntake
}

/** Drives an edit's added images the way an upload or paste drives the chat box's chips. Bound to
 *  one edit, so a late result never lands in another. */
export type QueuedEditImageIntake = {
  begin: (
    previewUrl?: string,
    pendingName?: string,
    selection?: QueuedEditImageSelection
  ) => string | null
  resolve: (id: string, path: string, connectionId?: string | null) => boolean
  reveal: (id: string, previewUrl?: string) => void
  /** False once the chip settled or the person removed it, so its file must not attach. */
  drop: (id: string) => boolean
  /** Adds settled images and references other files in the same text change. */
  append: (
    paths: string[],
    connectionId?: string | null,
    selection?: QueuedEditImageSelection
  ) => void
  remove: (id: string) => void
}

/** What the editor draws and acts on; absent against a host that edits text only. */
export type QueuedEditImagesEditor = {
  chips: NativeChatComposerImageAttachment[]
  intake: QueuedEditImageIntake
  /** Nothing to save: no text and no image, not even one still uploading. */
  empty: boolean
}

/** A new edit's images: the card's own, and an intake bound to that edit. */
export function queuedEditImageFields(
  body: AgentJournalMessageItem,
  edit: () => QueuedEditImageState,
  live: () => boolean,
  render: () => void
): Pick<QueuedEditImageState, 'kept' | 'added' | 'intake'> {
  return {
    kept: queuedEditKeptImages(body),
    added: [],
    intake: queuedEditImageIntake(edit, live, render)
  }
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
    empty: !result.ok && result.reason === 'empty' && !queuedEditImagesPending(edit)
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

/** Unsaved typing and settled additions go to the chat box in one step; true when anything went.
 *  The typing goes without the card's own images, so no marker may name one. An upload still
 *  pending drops, as on the phone: its edit is gone. */
export function handOffQueuedEdit(edit: QueuedEditImageState): boolean {
  const unchanged = edit.text === queuedEditBaseText(edit.body, edit.kept)
  const images = edit.added.flatMap((image) => (image.pending ? [] : [settled(image)]))
  const text = unchanged
    ? ''
    : stripSentImagePromptMarkers(
        promptMarkersToImageReferences(
          edit.text,
          [...edit.kept, ...edit.added].map(({ id }) => id),
          images.map(({ id }) => id)
        )
      )
  appendNativeChatDraftCache(edit.draftKey, text, undefined, images)
  return text !== '' || images.length > 0
}

function queuedEditImageIntake(
  edit: () => QueuedEditImageState,
  live: () => boolean,
  render: () => void
): QueuedEditImageIntake {
  const update = (
    added: QueuedEditImageState['added'],
    selection?: QueuedEditImageSelection,
    kept = edit().kept,
    fileReferences = ''
  ): void => {
    const current = edit()
    const from = [...current.kept, ...current.added].map(({ id }) => id)
    const to = [...kept, ...added].map(({ id }) => id)
    const addedIds = to.filter((id) => !from.includes(id))
    current.text = queuedEditTextForKeptImages(current.text, from, to)
    if (addedIds.length > 0 || fileReferences) {
      current.text = queuedEditTextWithAddedImages(
        current.text,
        to,
        addedIds,
        selection,
        fileReferences
      )
    }
    current.kept = kept
    current.added = added
    if (live()) {
      render()
    }
  }
  const pendingChip = (id: string) => edit().added.find((image) => image.id === id && image.pending)
  return {
    begin: (previewUrl, pendingName, selection) => {
      if (!live()) {
        return null
      }
      const id = createUuidV4()
      const chip = { id, path: '', pending: true, ...(previewUrl ? { previewUrl } : {}) }
      update([...edit().added, pendingName ? { ...chip, pendingName } : chip], selection)
      return id
    },
    resolve: (id, path, connectionId) => {
      const chip = pendingChip(id)
      if (!chip || !live()) {
        return false
      }
      const image = settled({ id, path, ...(connectionId ? { connectionId } : {}) })
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
    append: (paths, connectionId, selection) => {
      const images = paths.filter(isNativeChatImageAttachmentPath)
      const files = paths.filter((path) => !isNativeChatImageAttachmentPath(path))
      if (live() && paths.length > 0) {
        const link = connectionId ? { connectionId } : {}
        update(
          [...edit().added, ...images.map((path) => ({ id: createUuidV4(), path, ...link }))],
          selection,
          edit().kept,
          files.length ? `${files.map(formatNativeChatFileReference).join(' ')} ` : ''
        )
      }
    },
    remove: (id) => {
      const current = edit()
      current.added.filter((entry) => entry.id === id).forEach(releasePreview)
      update(
        current.added.filter((entry) => entry.id !== id),
        undefined,
        current.kept.filter((entry) => entry.id !== id)
      )
    }
  }
}
