import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../src/shared/clipboard-image'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { useMediaPicker } from '../platform/media-picker'
import {
  ImageLibraryPermissionError,
  type MobileImageSource
} from '../platform/media-picker-contract'
import {
  uploadMobileNativeChatImages,
  type PendingNativeChatImage
} from './mobile-native-chat-image-attachment'

type CurrentRef<T> = { readonly current: T }
type UploadedNativeChatImage = Omit<PendingNativeChatImage, 'id'>
type ShowToast = (message: string, durationMs?: number) => void

/** Where an upload's images go: `onStart` once the transfer begins, then each image as it lands. */
export type MobileNativeChatImageUploadSink = {
  onStart: () => void
  onImage: (image: UploadedNativeChatImage) => void
}

export function useMobileNativeChatImageUpload(args: {
  client: RpcClient | null
  activeHandleRef: CurrentRef<string | null>
  getActiveWorktreeConnectionId: () => Promise<string | null>
  connState: ConnectionState
  scopeKey: string | null
  structuredNativeChat: boolean
  showToast: ShowToast
  onImagesUploaded: (scope: string, images: UploadedNativeChatImage[]) => void
  onAttachSuccess?: () => void
  onError?: () => void
}): {
  attachImage: (source: MobileImageSource) => Promise<void>
  isAttaching: boolean
  uploadImages: (source: MobileImageSource, sink: MobileNativeChatImageUploadSink) => Promise<void>
} {
  const {
    activeHandleRef,
    client,
    connState,
    getActiveWorktreeConnectionId,
    onAttachSuccess,
    onError,
    onImagesUploaded,
    scopeKey,
    showToast,
    structuredNativeChat
  } = args
  const [isAttaching, setIsAttaching] = useState(false)
  const picker = useMediaPicker()
  const attachingCount = useRef(0)
  const connStateRef = useRef(connState)
  useLayoutEffect(() => {
    connStateRef.current = connState
  }, [connState])

  /** Picks and uploads; each finished image reaches `sink`, and a failure is told as a toast. */
  const uploadImages = useCallback(
    async (source: MobileImageSource, sink: MobileNativeChatImageUploadSink): Promise<void> => {
      if (
        !client ||
        connState !== 'connected' ||
        (!activeHandleRef.current && !structuredNativeChat)
      ) {
        return
      }
      let uploaded = false
      try {
        await uploadMobileNativeChatImages(source, {
          client,
          getConnectionId: getActiveWorktreeConnectionId,
          pickImages: picker.pickImages,
          onImageUploaded: (image) => {
            uploaded = true
            sink.onImage(image)
          },
          onUploadStart: sink.onStart
        })
      } catch (uploadError) {
        const message = uploadError instanceof Error ? uploadError.message : String(uploadError)
        onError?.()
        if (connStateRef.current !== 'connected') {
          showToast('Attach failed (disconnected)', 1500)
        } else if (uploadError instanceof ImageLibraryPermissionError) {
          showToast('Photo permission denied', 1500)
        } else if (message === CLIPBOARD_IMAGE_TOO_LARGE_ERROR) {
          showToast('Image too large to attach', 1500)
        } else {
          showToast('Attach failed', 1500)
        }
      }
      if (uploaded) {
        onAttachSuccess?.()
      }
    },
    [
      activeHandleRef,
      client,
      connState,
      getActiveWorktreeConnectionId,
      onAttachSuccess,
      onError,
      picker,
      showToast,
      structuredNativeChat
    ]
  )

  const attachImage = useCallback(
    async (source: MobileImageSource): Promise<void> => {
      const scope = scopeKey
      if (!scope) {
        return
      }
      let started = false
      const uploadedImages: UploadedNativeChatImage[] = []
      try {
        await uploadImages(source, {
          onImage: (image) => uploadedImages.push(image),
          onStart: () => {
            started = true
            attachingCount.current += 1
            setIsAttaching(true)
          }
        })
      } finally {
        if (started) {
          attachingCount.current -= 1
          if (attachingCount.current === 0) {
            setIsAttaching(false)
          }
        }
      }
      if (uploadedImages.length > 0) {
        onImagesUploaded(scope, uploadedImages)
      }
    },
    [onImagesUploaded, scopeKey, uploadImages]
  )

  return { attachImage, isAttaching, uploadImages }
}
