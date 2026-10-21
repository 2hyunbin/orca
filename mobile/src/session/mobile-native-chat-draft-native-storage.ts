import AsyncStorage from '@react-native-async-storage/async-storage'
import { persistMirrored, readMirroredKeyOrStore } from '../storage/mirrored-storage-keys'
import { mobileChatDraftKeyScope } from './mobile-native-chat-draft-data'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'

export async function removeStoredMobileChatDrafts(
  hostId: string,
  workspaceId?: string
): Promise<void> {
  const keys = (await AsyncStorage.getAllKeys()).filter((key) => {
    const scope = mobileChatDraftKeyScope(key)
    return scope?.[0] === hostId && (workspaceId === undefined || scope[1] === workspaceId)
  })
  await Promise.all(keys.map((key) => persistMirrored(key, null)))
}

export function installNativeMobileChatDraftStorage(): void {
  publishMobileChatDraftStorage({
    read: readMirroredKeyOrStore,
    write: persistMirrored,
    removeWorkspace: removeStoredMobileChatDrafts
  })
}
