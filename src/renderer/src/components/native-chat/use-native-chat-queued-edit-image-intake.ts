// Paste, drop and Attach into a queued card's edit, through the chat box's own intake with the
// edit's in-memory images as the sink, so the chat box's draft and chips are never touched.

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type RefObject
} from 'react'
import { toast } from 'sonner'
import { createOsFileDropSequence, useOsFileDropOwner } from '@/hooks/use-os-file-drop-owner'
import { getNativeFileDropRejectionMessage } from '@/lib/native-file-drop-rejection-message'
import { formatNativeChatFileReference } from './native-chat-composer-target'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatResolvedPathOptions } from './native-chat-resolved-path-ownership'
import type { NativeChatPendingAttachmentChips } from './native-chat-session-attachment-drop'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'
import { useNativeChatExternalAttachments } from './use-native-chat-external-attachments'
import { useNativeChatFileAttachmentActions } from './use-native-chat-file-attachment-actions'
import { registerNestedWorkspaceDropSink } from './native-chat-pane-file-drop'
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'

/** The chat a queued list sits in, which its edits attach files to as its chat box does. */
export type QueuedEditAttachTarget = {
  terminalTabId: string
  transport: Pick<
    NativeChatStructuredComposerTransport,
    'acceptsImages' | 'worktreeId' | 'sessionId' | 'runtimeEnvironmentId'
  >
}

const noop = (): void => {}

export function useNativeChatQueuedEditImageIntake(
  editor: QueuedMessageInlineEditor,
  attachTo: QueuedEditAttachTarget | undefined,
  field: RefObject<HTMLTextAreaElement | null>
): {
  /** The host replaces images and the agent reads them: Attach, paste and drop add to the edit. */
  editable: boolean
  attach: () => void
  /** On the whole card, so a paste with focus on its buttons lands in the edit too. */
  onPasteCapture: (event: ClipboardEvent<HTMLDivElement>) => void
  hostEnvironmentId: string | undefined
  isDragActive: boolean
} {
  const intake = editor.images?.intake
  const transport = attachTo?.transport
  const editable = Boolean(intake && transport && transport.acceptsImages !== false)
  const { change, saving, acquiring } = editor
  // Nothing joins an edit until its lease is held, nor while a Save sends the images it read.
  const busy = saving || acquiring
  const [isDragActive, setIsDragActive] = useState(false)
  const pendingCaret = useRef<{ end: number; length: number } | null>(null)
  const imageSelection = useCallback(
    (requireFocus = true) => {
      const input = field.current
      if (!input || (requireFocus && input !== document.activeElement)) {
        return undefined
      }
      pendingCaret.current = { end: input.selectionEnd, length: input.value.length }
      return { start: input.selectionStart, end: input.selectionEnd }
    },
    [field]
  )
  useLayoutEffect(() => {
    const caret = pendingCaret.current
    pendingCaret.current = null
    const input = field.current
    if (caret && input === document.activeElement) {
      const position = caret.end + editor.text.length - caret.length
      input?.setSelectionRange(position, position)
    }
  }, [editor.text, field])
  const liveIntake = useRef(intake)
  useLayoutEffect(() => {
    liveIntake.current = intake
  }, [intake])
  const setNotice = useCallback((notice: string | null) => {
    if (notice) {
      toast.error(notice)
    }
  }, [])
  // At the caret, as the chat box inserts; never into an edit that replaced this one.
  const insertText = useCallback(
    (insertion: string): boolean => {
      const input = field.current
      if (!input || liveIntake.current !== intake) {
        return false
      }
      const { value, selectionStart, selectionEnd } = input
      change(value.slice(0, selectionStart) + insertion + value.slice(selectionEnd))
      return true
    },
    [change, field, intake]
  )
  const insertReferences = useCallback(
    (paths: string[]) => {
      if (paths.length > 0) {
        insertText(`${paths.map(formatNativeChatFileReference).join(' ')} `)
      }
    },
    [insertText]
  )
  const pendingChips = useMemo(
    (): NativeChatPendingAttachmentChips => ({
      begin: (previewUrl, pendingName) =>
        intake?.begin(previewUrl, pendingName, imageSelection()) ?? null,
      resolve: (id, path, connectionId) => intake?.resolve(id, path, connectionId) ?? false,
      drop: (id) => intake?.drop(id) ?? false,
      // A stored file that is not an image is referenced in the text, as the chat box does.
      attachReferences: (references) => {
        const kept = references.filter(({ id }) => intake?.drop(id))
        intake?.append(
          kept.map(({ path }) => path),
          undefined,
          imageSelection(false)
        )
        return kept.length > 0
      }
    }),
    [imageSelection, intake]
  )
  const attachResolvedPaths = useCallback(
    (
      paths: string[],
      connectionId?: string | null,
      options: NativeChatResolvedPathOptions = {}
    ) => {
      const { operation } = options
      try {
        const current =
          options.destinationIsCurrent?.() !== false && options.targetOwnerIsCurrent?.() !== false
        if (!intake || !current || busy) {
          return
        }
        if (operation) {
          operation.apply(insertReferences)
        } else {
          intake.append(
            paths,
            connectionId,
            imageSelection(paths.some(isNativeChatImageAttachmentPath))
          )
        }
      } finally {
        operation?.cancel()
      }
    },
    [busy, imageSelection, insertReferences, intake]
  )
  const disabled = !editable || busy
  const external = useNativeChatExternalAttachments({
    terminalTabId: attachTo?.terminalTabId ?? '',
    structuredWorktreeId: transport?.worktreeId,
    structuredSession: transport
      ? { sessionId: transport.sessionId, runtimeEnvironmentId: transport.runtimeEnvironmentId }
      : undefined,
    disabled,
    attachResolvedPaths,
    pendingChips,
    setNotice
  })
  const { captureReservedAttachments, captureExternalDrop } = external
  const captureCopiedFiles = useCallback(
    (options?: { focus?: boolean }) => captureReservedAttachments(undefined, options),
    [captureReservedAttachments]
  )
  const { handlePaste } = useNativeChatComposerPaste({
    targetKey: editor.messageId,
    disabled,
    caret: 0,
    resolveAttachmentOwner: external.resolveAttachmentOwner,
    attachResolvedPaths,
    attachCopiedFiles: external.attachExternalPaths,
    captureCopiedFiles,
    beginPendingImageAttachment: pendingChips.begin,
    resolvePendingImageAttachment: pendingChips.resolve,
    revealPendingImageAttachment: intake?.reveal,
    dropPendingImageAttachment: pendingChips.drop,
    insertTypedText: insertText,
    setCaret: noop,
    setNotice
  })
  const onPasteCapture = useCallback(
    (event: ClipboardEvent<HTMLDivElement>) => {
      // Text alone pastes natively; a picture or copied files take the chat box's paste flow.
      if (editable && Array.from(event.clipboardData.items).some((item) => item.kind === 'file')) {
        handlePaste(event)
      }
    },
    [editable, handlePaste]
  )
  // The editing card is the nearest drop owner, so a drop on it never reaches the chat box's.
  const ownerRef = useRef<HTMLElement | null>(null)
  const [sequence] = useState(createOsFileDropSequence)
  const attachOwner = useOsFileDropOwner(ownerRef, {
    consumer: 'agent',
    sequence,
    canAccept: () => !disabled,
    captureDestination: () => captureExternalDrop(),
    onDrop: async (prepared, { destination }) => {
      for (const failure of prepared.failures) {
        const message = getNativeFileDropRejectionMessage(failure)
        toast.error(message.title, { description: message.description })
      }
      await destination?.(prepared.paths)
    }
  })
  useLayoutEffect(() => {
    const card = field.current?.closest('[data-queued-message-editor]')
    const owner = editable && card instanceof HTMLElement ? card : null
    attachOwner(owner)
    // A file dragged from Orca's own tree: the chat box's claim checks it, then hands it here.
    const hover = (active: boolean): void => setIsDragActive(active && !disabled)
    const unregister = owner
      ? registerNestedWorkspaceDropSink(owner, attachResolvedPaths, hover)
      : null
    const clear = (): void => setIsDragActive(false)
    clear()
    document.addEventListener('drop', clear, true)
    document.addEventListener('dragend', clear, true)
    return () => {
      attachOwner(null)
      unregister?.()
      document.removeEventListener('drop', clear, true)
      document.removeEventListener('dragend', clear, true)
    }
  }, [attachOwner, attachResolvedPaths, disabled, editable, field])
  const { pickAttachments } = useNativeChatFileAttachmentActions(external.attachExternalPaths)
  return {
    editable,
    attach: pickAttachments,
    onPasteCapture,
    isDragActive: isDragActive && !disabled,
    hostEnvironmentId: transport?.runtimeEnvironmentId ?? undefined
  }
}
