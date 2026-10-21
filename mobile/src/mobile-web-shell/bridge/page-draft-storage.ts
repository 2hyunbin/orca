import type { BridgeRpcClient } from './bridge-rpc-client'
import { storageReadResultSchema } from './bridge-native-verbs'
import { draftWriteResultSchema } from './bridge-draft-storage'
import {
  MOBILE_CHAT_DRAFT_CHUNK_CHARS,
  mobileChatDraftStorageKey
} from '../../session/mobile-native-chat-draft-data'
import { publishMobileChatDraftStorage } from '../../session/mobile-native-chat-draft-storage'

export function installPageChatDraftStorage(client: BridgeRpcClient): void {
  const grants = client.getShellSession()?.grants.native ?? []
  if (!grants.includes('native.storage.write') || !grants.includes('native.storage.read')) {
    publishMobileChatDraftStorage(null)
    return
  }
  const write = async (key: string, value: string | null): Promise<void> => {
    const writeId = `${Date.now()}-${Math.random()}`
    const total = Math.max(1, Math.ceil((value?.length ?? 0) / MOBILE_CHAT_DRAFT_CHUNK_CHARS))
    for (let index = 0; index < total; index++) {
      const result = draftWriteResultSchema.parse(
        (
          await client.callNativeVerb('native.storage.write', {
            key,
            writeId,
            index,
            total,
            value:
              value === null
                ? null
                : value.slice(
                    index * MOBILE_CHAT_DRAFT_CHUNK_CHARS,
                    (index + 1) * MOBILE_CHAT_DRAFT_CHUNK_CHARS
                  )
          })
        ).result
      )
      if (result.committed !== (index + 1 === total)) {
        throw new Error('Draft storage did not commit')
      }
    }
  }
  publishMobileChatDraftStorage({
    read: async (key) =>
      storageReadResultSchema.parse(
        (await client.callNativeVerb('native.storage.read', { key })).result
      ).value,
    write,
    removeWorkspace: async (hostId, workspaceId) => {
      if (workspaceId !== undefined) {
        await write(mobileChatDraftStorageKey(`${hostId}\0${workspaceId}\0`), null)
      }
    }
  })
}
