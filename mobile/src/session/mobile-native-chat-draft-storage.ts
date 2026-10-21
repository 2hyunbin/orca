export type MobileChatDraftStorage = {
  read(key: string): Promise<string | null>
  write(key: string, value: string | null): Promise<void>
  removeWorkspace(hostId: string, workspaceId?: string): Promise<void>
}
let storage: MobileChatDraftStorage | null = null

/** Native startup and the downloaded page supply their own acknowledged storage adapters. */
export function publishMobileChatDraftStorage(next: MobileChatDraftStorage | null): void {
  storage = next
}
export function mobileChatDraftStorage(): MobileChatDraftStorage | null {
  return storage
}
