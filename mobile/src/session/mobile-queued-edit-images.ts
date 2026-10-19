import { useCallback, useRef } from 'react'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'
import {
  queuedEditBaseText,
  queuedEditTextForKeptImages,
  type QueuedMessageEditDraft
} from '../../../src/shared/queued-message-edit'
import { stripSentImagePromptMarkers } from '../../../src/shared/native-chat-image-transcript-markers'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobileImageSource } from '../platform/media-picker-contract'
import type { MobileNativeChatImageUploadSink } from './use-mobile-native-chat-image-upload'
import { mobileQueuedImageLabel } from './mobile-structured-queued-message-cards'

type UploadedImage = Omit<PendingNativeChatImage, 'id'>

/** The chat box's photo picker and attachment list, lent to a queued card's editor. */
export type MobileQueuedEditComposerImages = {
  upload: (sink: MobileNativeChatImageUploadSink) => Promise<void>
  /** Adds photos to this chat box's attachments; false when there is none. */
  append: (images: readonly UploadedImage[]) => boolean
}

/** The chat box's upload and attachment list, as a queued edit borrows them. */
export function mobileQueuedEditComposerImages(
  scopeKey: string | null,
  upload: (source: MobileImageSource, sink: MobileNativeChatImageUploadSink) => Promise<void>,
  addImages: (scope: string, images: UploadedImage[]) => void
): MobileQueuedEditComposerImages {
  return {
    upload: (sink) => upload('library', sink),
    append: (images) => {
      if (scopeKey) {
        addImages(scopeKey, [...images])
      }
      return scopeKey !== null
    }
  }
}

export type MobileQueuedEditImageState = Omit<QueuedMessageEditDraft, 'added'> & {
  added: readonly (PendingNativeChatImage & { pending?: boolean })[]
  composerImages?: MobileQueuedEditComposerImages
}

/** Only typing and settled additions survive a hand-off; kept images stay with the card. */
export function handOffMobileQueuedEdit(
  edit: MobileQueuedEditImageState & { body: AgentSessionQueuedMessage['body'] },
  appendText: ((text: string) => boolean) | undefined
): boolean {
  const text =
    edit.text === queuedEditBaseText(edit.body, edit.kept)
      ? ''
      : stripSentImagePromptMarkers(edit.text, edit.kept.length)
  const added = edit.added.filter((image) => !image.pending)
  return (
    (text.trim() !== '' || added.length > 0) &&
    (!text.trim() || appendText?.(text) === true) &&
    (added.length === 0 || edit.composerImages?.append(added) === true)
  )
}

/** A tile in the editor's strip; a bare host path has no loadable preview and shows its name. */
export type MobileQueuedEditImageTile = Pick<PendingNativeChatImage, 'id' | 'previewUri'> & {
  name: string
}

/** What the editor draws and acts on; absent against a host that edits text only. */
export type MobileQueuedEditImagesEditor = {
  tiles: MobileQueuedEditImageTile[]
  uploading: boolean
  /** Absent where the agent takes no images; removing still works. */
  attach?: () => void
  remove: (id: string) => void
}

export function mobileQueuedEditImageTiles(
  edit: MobileQueuedEditImageState
): MobileQueuedEditImageTile[] {
  return [
    ...edit.kept.map(({ id, block }) => ({
      id,
      previewUri: block.url ?? block.path ?? '',
      name: mobileQueuedImageLabel(block)
    })),
    ...edit.added
      .filter((image) => !image.pending)
      .map((image) => ({ id: image.id, previewUri: image.previewUri, name: 'Photo' }))
  ]
}

type EditImagesRef<E> = { current: E | null }

/** Attach and remove for the open edit; a reply landing after it closed changes nothing shown. */
export function useMobileQueuedEditImageActions<
  E extends MobileQueuedEditImageState & { saving: boolean }
>(
  active: EditImagesRef<E>,
  render: (edit: E) => void
): { attach: () => void; remove: (id: string) => void } {
  const addedIds = useRef(0)
  const remove = useCallback(
    (id: string) => {
      const edit = active.current
      if (edit && !edit.saving) {
        const kept = edit.kept.filter((entry) => entry.id !== id)
        edit.text = queuedEditTextForKeptImages(
          edit.text,
          edit.kept.map((entry) => entry.id),
          kept.map((entry) => entry.id)
        )
        edit.kept = kept
        edit.added = edit.added.filter((entry) => entry.id !== id)
        render(edit)
      }
    },
    [active, render]
  )
  const attach = useCallback(() => {
    const edit = active.current
    if (!edit || edit.saving || !edit.composerImages) {
      return
    }
    const shown = (): void => {
      if (active.current === edit) {
        render(edit)
      }
    }
    const pendingId = `upload-${++addedIds.current}`
    // A photo landing after the edit closed belongs to no card; its upload is left unused.
    void edit.composerImages
      .upload({
        onStart: () => {
          edit.added = [...edit.added, { id: pendingId, path: '', previewUri: '', pending: true }]
          shown()
        },
        onImage: (image) => {
          addedIds.current += 1
          edit.added = [...edit.added, { id: `added-${addedIds.current}`, ...image }]
          shown()
        }
      })
      .finally(() => {
        edit.added = edit.added.filter((image) => image.id !== pendingId)
        shown()
      })
  }, [active, render])
  return { attach, remove }
}
