import { setMobileNativeChatDraftText } from './native-chat/composer/mobile-native-chat-draft-store'
import { appendReturnedDraftText } from '../../../src/shared/returned-draft-text'
import { useContext, useEffect, useLayoutEffect, useRef, useCallback } from 'react'
import { MobileQueuedMessageComposerContext } from './mobile-queued-message-composer-context'
import { Text, type TextInput, View } from 'react-native'
import { MobileNativeChatComposer } from './native-chat/composer/MobileNativeChatComposer'
import type { MobileQueuedMessageInlineEditor } from './use-mobile-structured-queued-edit'
import { useMobileNativeChatFileAttachments } from './native-chat/composer/use-mobile-native-chat-file-attachments'
import { useMobileNativeChatImageUpload } from './native-chat/composer/use-mobile-native-chat-image-upload'
import {
  updateMobileNativeChatDraftInputs,
  mobileNativeChatDraftDestination,
  useMobileNativeChatDraftInputs
} from './native-chat/composer/mobile-native-chat-draft-inputs'
import {
  isStructuredAgentSessionComposerCommand,
  isStructuredAgentSessionGoalCommand
} from '../../../src/shared/structured-agent-session-composer'
import { colors } from '../theme/mobile-theme'
import { createUuidV4 } from '../../../src/shared/uuid-v4'

export function MobileQueuedMessageComposer({
  editor,
  attribution
}: {
  editor: MobileQueuedMessageInlineEditor
  attribution: string | null
}): React.JSX.Element {
  const context = useContext(MobileQueuedMessageComposerContext)
  const inputRef = useRef<TextInput>(null)
  const emptyHandle = useRef<string | null>(null)
  const inputs = useMobileNativeChatDraftInputs(editor.scopeKey)
  const files = useMobileNativeChatFileAttachments({
    client: editor.client,
    sessionId: editor.sessionId,
    scopeKey: editor.scopeKey,
    enabled: !editor.saving,
    showToast: (message) => context?.onError(message)
  })
  const images = useMobileNativeChatImageUpload({
    client: editor.client,
    activeHandleRef: emptyHandle,
    getActiveWorktreeConnectionId: async () => null,
    connState: 'connected',
    scopeKey: editor.scopeKey,
    structuredNativeChat: true,
    showToast: (message) => context?.onError(message),
    onImagesUploaded: (scope, images) =>
      updateMobileNativeChatDraftInputs(scope, (current) => ({
        ...current,
        images: [...current.images, ...images.map((image) => ({ ...image, id: createUuidV4() }))]
      }))
  })
  const latestEditor = useRef(editor)
  useLayoutEffect(() => {
    latestEditor.current = editor
  }, [editor])
  const destination = useRef(mobileNativeChatDraftDestination(editor.scopeKey)).current
  const insertDictation = useCallback(
    (text: string) => {
      if (!destination.active) {
        return
      }
      if (destination.scope !== editor.scopeKey) {
        setMobileNativeChatDraftText(destination.scope, (before) =>
          appendReturnedDraftText(before, text)
        )
      } else {
        latestEditor.current.change(appendReturnedDraftText(latestEditor.current.text, text))
      }
    },
    [destination, editor.scopeKey]
  )
  useEffect(() => {
    inputRef.current?.focus()
  }, [])
  const refuseCommand = (text: string): boolean => {
    if (
      !isStructuredAgentSessionComposerCommand(
        text,
        context?.agent ?? 'codex',
        context?.structured?.catalog.reported
      ) &&
      !isStructuredAgentSessionGoalCommand(text) &&
      !/^\/resume(?:\s|$)/i.test(text)
    ) {
      return false
    }
    context?.onError("Commands can't be saved in a queued message.")
    return true
  }
  return (
    <View testID="queued-card-editor">
      <Text style={{ color: colors.textMuted }}>
        Editing message{attribution ? ` · ${attribution}` : ''}
      </Text>
      <MobileNativeChatComposer
        inputRef={inputRef}
        draftScopeKey={editor.scopeKey}
        insertDictation={insertDictation}
        agent={context?.agent}
        value={editor.text}
        onChangeText={editor.change}
        onSend={async (text) => (refuseCommand(text) ? false : editor.save())}
        editSession={{ cancel: editor.cancel, locked: editor.saving, refuseCommand }}
        sendSurfaceId={editor.scopeKey}
        getSendCompletionGeneration={() => 0}
        getComposerEditGeneration={() => 0}
        disabled={editor.saving}
        sendDisabled={!editor.canSave}
        structured={
          context?.structured
            ? {
                ...context.structured,
                files: files.files,
                onAttachFiles: () => void files.attachFiles(),
                onRemoveFile: (id) => files.removeFiles([id])
              }
            : null
        }
        filePaths={context?.filePaths}
        onNeedFiles={context?.onNeedFiles}
        onPickSkill={(skill) =>
          updateMobileNativeChatDraftInputs(editor.scopeKey, (current) => ({
            ...current,
            skills: [...current.skills.filter(({ name }) => name !== skill.name), skill]
          }))
        }
        attachments={[...inputs.images]}
        onRemoveAttachment={editor.imagesCapable ? editor.removeImage : undefined}
        onAttachImage={
          editor.imagesCapable
            ? () => {
                updateMobileNativeChatDraftInputs(editor.scopeKey, (current) => ({
                  ...current,
                  pending: (current.pending ?? 0) + 1
                }))
                void images.attachImage('library').finally(() =>
                  updateMobileNativeChatDraftInputs(destination, (current) => ({
                    ...current,
                    pending: Math.max(0, (current.pending ?? 0) - 1)
                  }))
                )
              }
            : undefined
        }
        isAttaching={images.isAttaching}
        onMicPress={context?.onMicPress}
        micActive={context?.micActive}
        dictationMode={context?.dictationMode}
        onMicPressIn={context?.onMicPressIn}
        onMicPressOut={context?.onMicPressOut}
      />
    </View>
  )
}
