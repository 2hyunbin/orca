import { expect, it, vi } from 'vitest'

const disk = vi.hoisted(() => new Map<string, string>())
const io = vi.hoisted(() => ({ beforeSet: async () => {} }))
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => disk.get(key) ?? null,
    getAllKeys: async () => [...disk.keys()],
    setItem: async (key: string, value: string) => {
      await io.beforeSet()
      disk.set(key, value)
    },
    removeItem: async (key: string) => {
      disk.delete(key)
    }
  }
}))

it.each(['stored', 'pending', 'disposed'] as const)(
  'refuses actual queued Delete after native %s copy authority ends before acknowledgment',
  async (schedule) => {
    vi.resetModules()
    disk.clear()
    io.beforeSet = async () => {}
    const native = await import('./mobile-native-chat-draft-native-storage')
    const bridge = await import('../mobile-web-shell/bridge/bridge-draft-storage')
    const { storageReadParamsSchema } =
      await import('../mobile-web-shell/bridge/bridge-native-verbs')
    const check = native.nativeChatDraftSession('ack-document')
    const writer = bridge.createBridgeDraftWriter({
      mayWrite: () => true,
      check,
      commit: native.writeNativeMobileChatDraft,
      removeWorkspace: native.removeStoredMobileChatDrafts
    })
    // Native and page modules retain independent authority, as in the shipping shell.
    vi.resetModules()
    const page = await import('../mobile-web-shell/bridge/page-draft-storage')
    const owner = await import('./mobile-native-chat-draft-store')
    const storage = await import('./mobile-native-chat-draft-storage')
    const { createFakeBridgePortPair } =
      await import('../mobile-web-shell/bridge/bridge-port-pair-test-harness')
    const pair = createFakeBridgePortPair({
      serveNativeVerb: async (verb, params) => {
        if (verb === 'native.storage.read') {
          return {
            value: await native.readNativeMobileChatDraft(
              storageReadParamsSchema.parse(params).key,
              check
            )
          }
        }
        if (verb === 'native.storage.write') {
          return writer.write(params)
        }
        throw new Error(`Unexpected native verb: ${verb}`)
      }
    })
    const scope = 'native-ack\0workspace\0tab'
    const key = 'orca:mobileChatDraft:native-ack:workspace:tab'
    if (schedule === 'stored') {
      disk.set(key, JSON.stringify({ text: 'saved before Edit', images: [] }))
    }
    await pair.flush()
    page.installPageChatDraftStorage(pair.client)
    const hydration = owner.hydrateMobileNativeChatDraft(scope)
    await pair.flush()
    await hydration
    let release = () => {}
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    io.beforeSet = async () => {
      entered()
      await gate
    }
    const { createElement } = await import('react')
    const { act, create } = await import('react-test-renderer')
    const { useMobileQueuedMessageComposerActions } =
      await import('./use-mobile-queued-message-composer-actions')
    const deleteRemoteQueue = vi.fn(async () => {
      throw new Error('Revoked copy must not delete')
    })
    const feedback = vi.fn()
    let actions: ReturnType<typeof useMobileQueuedMessageComposerActions>
    function Harness() {
      actions = useMobileQueuedMessageComposerActions({
        sessionKey: scope,
        sessionId: 'chat',
        messages: [
          {
            messageId: 'Q',
            position: 1,
            state: 'waiting',
            body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued Q' }] }
          }
        ],
        copyCapable: true,
        reorderCapable: false,
        queuedImageCards: false,
        enabled: true,
        promptPending: false,
        copyQueuedMessage: () =>
          owner.appendMobileNativeChatDraft(scope, { text: 'queued Q', images: [] }),
        mutate: deleteRemoteQueue,
        onSendError: feedback
      })
      return null
    }
    let rendered: ReturnType<typeof create> | undefined
    try {
      await act(async () => {
        rendered = create(createElement(Harness))
      })
      let edit: Promise<boolean>
      await act(async () => {
        edit = actions.copyEdit!('Q')
        await pair.flush()
        await started
      })
      let cleanup: Promise<void> = Promise.resolve()
      if (schedule === 'disposed') {
        writer.dispose()
      } else {
        cleanup = native.removeStoredMobileChatDrafts('native-ack', 'workspace')
        expect(() => check(key)).toThrow()
      }
      release()
      await act(async () => {
        await cleanup
        await pair.flush()
        expect(await edit).toBe(false)
      })
      expect(deleteRemoteQueue).not.toHaveBeenCalled()
      expect(feedback).toHaveBeenCalledOnce()
      expect(owner.readMobileNativeChatDraft(scope).text).toContain('queued Q')
      if (schedule !== 'disposed') {
        expect(disk.has(key)).toBe(false)
      }
    } finally {
      release()
      await act(async () => rendered?.unmount())
      writer.dispose()
      pair.client.close()
      storage.publishMobileChatDraftStorage(null)
      owner.resetMobileNativeChatDraftStoreForTests()
      native.closeNativeChatDraftSession('ack-document')
    }
  }
)

it('acknowledges its own cleanup sentinel only while the writer remains open', async () => {
  vi.resetModules()
  const native = await import('./mobile-native-chat-draft-native-storage')
  const { createBridgeDraftWriter } =
    await import('../mobile-web-shell/bridge/bridge-draft-storage')
  for (const disposed of [false, true]) {
    const host = `sentinel-${disposed}`
    const check = native.nativeChatDraftSession(host)
    const sentinel = `orca:mobileChatDraft:${host}:workspace:`
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = createBridgeDraftWriter({
      mayWrite: () => true,
      check,
      commit: native.writeNativeMobileChatDraft,
      removeWorkspace: async (h, w) => {
        await gate
        await native.removeStoredMobileChatDrafts(h, w)
      }
    })
    const result = writer.write({
      key: sentinel,
      writeId: 'cleanup',
      index: 0,
      total: 1,
      value: null
    })
    if (disposed) {
      writer.dispose()
    }
    release()
    if (disposed) {
      await expect(result).rejects.toThrow('This draft writer has ended')
    } else {
      expect(await result).toEqual({ committed: true })
    }
    expect(() => check(sentinel)).toThrow()
    writer.dispose()
    native.closeNativeChatDraftSession(host)
  }
})
