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
import type { QueuedMessageInlineEditor } from './use-structured-agent-session-queued-edit'

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
  onPasteCapture: (event: ClipboardEvent<HTMLTextAreaElement>) => void
  hostEnvironmentId: string | undefined
} {
  const intake = editor.images?.intake
  const transport = attachTo?.transport
  const editable = Boolean(intake && transport && transport.acceptsImages !== false)
  const { change } = editor
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
      begin: (previewUrl, pendingName) => intake?.begin(previewUrl, pendingName) ?? null,
      resolve: (id, path, connectionId) => intake?.resolve(id, path, connectionId) ?? false,
      drop: (id) => intake?.drop(id) ?? false,
      // A stored file that is not an image is referenced in the text, as the chat box does.
      attachReferences: (references) => {
        const kept = references.filter(({ id }) => intake?.drop(id))
        insertReferences(kept.map(({ path }) => path))
        return kept.length > 0
      }
    }),
    [insertReferences, intake]
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
        if (!intake || !current) {
          return
        }
        if (operation) {
          operation.apply(insertReferences)
        } else {
          insertReferences(intake.append(paths, connectionId))
        }
      } finally {
        operation?.cancel()
      }
    },
    [insertReferences, intake]
  )
  const disabled = !editable || editor.saving
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
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
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
    attachOwner(editable ? (field.current?.closest('li') ?? null) : null)
    return () => attachOwner(null)
  }, [attachOwner, editable, field])
  const { pickAttachments } = useNativeChatFileAttachmentActions(external.attachExternalPaths)
  return {
    editable,
    attach: pickAttachments,
    onPasteCapture,
    hostEnvironmentId: transport?.runtimeEnvironmentId ?? undefined
  }
}
