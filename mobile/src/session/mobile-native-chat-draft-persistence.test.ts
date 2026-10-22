import { copyMobileQueuedMessageToDraft } from './mobile-native-chat-queued-extraction'
import { structuredAgentSessionSendBody } from '../../../src/shared/structured-agent-session-send-mutation'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { afterEach, expect, it, vi } from 'vitest'
import {
  editMobileNativeChatDraft,
  hydrateMobileNativeChatDraft,
  persistMobileNativeChatDraft,
  readMobileNativeChatDraft,
  resetMobileNativeChatDraftStoreForTests,
  updateMobileNativeChatDraftImages,
  deleteMobileNativeChatDrafts
} from './mobile-native-chat-draft-store'
import {
  mobileChatDraftStorageKey,
  MOBILE_CHAT_DRAFT_CHUNK_CHARS
} from './mobile-native-chat-draft-data'
import { publishMobileChatDraftStorage } from './mobile-native-chat-draft-storage'
import {
  installNativeMobileChatDraftStorage,
  removeStoredMobileChatDrafts
} from './mobile-native-chat-draft-native-storage'
import { persistMirrored } from '../storage/mirrored-storage-keys'
import {
  createBridgeDraftWriter,
  pageMayAccessChatDraft
} from '../mobile-web-shell/bridge/bridge-draft-storage'
import {
  isBridgeFrameWithinCap,
  BRIDGE_MAX_REPLY_BYTES,
  utf8ByteLength
} from '../mobile-web-shell/bridge/bridge-caps'
import { pageStorageKeysForRoute } from '../mobile-web-shell/page-storage-keys'

const disk = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => disk.get(key) ?? null,
    getAllKeys: async () => [...disk.keys()],
    setItem: async (key: string, value: string) => {
      disk.set(key, value)
    },
    removeItem: async (key: string) => {
      disk.delete(key)
    }
  }
}))
afterEach(() => {
  resetMobileNativeChatDraftStoreForTests()
  publishMobileChatDraftStorage(null)
})

it('commits a large image/skill draft before acknowledgement, restores it, and deletes only its workspace', async () => {
  const scope = 'host\0workspace\0tab'
  const key = mobileChatDraftStorageKey(scope)
  const other = mobileChatDraftStorageKey('host\0other\0tab')
  const value = JSON.stringify({
    text: '"\\\n'.repeat(40_000) + '$review',
    images: [
      {
        id: 'remote',
        path: '',
        reference: { url: 'https://example.com/image.png', alt: 'diagram' }
      }
    ],
    skills: [{ name: 'review', path: '/skills/review' }]
  })
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const writer = createBridgeDraftWriter({
    mayWrite: (candidate) =>
      pageMayAccessChatDraft(candidate, 'host', '/h/host/session/workspace', false),
    commit: async (candidate, content) => {
      await gate
      await persistMirrored(candidate, content)
    },
    removeWorkspace: removeStoredMobileChatDrafts
  })
  expect(pageStorageKeysForRoute('host', '/h/host/session/workspace')).not.toContain(key)
  expect(pageMayAccessChatDraft(other, 'host', '/h/host/session/workspace', false)).toBe(false)
  expect(utf8ByteLength(JSON.stringify({ value }))).toBeLessThan(BRIDGE_MAX_REPLY_BYTES)
  const total = Math.ceil(value.length / MOBILE_CHAT_DRAFT_CHUNK_CHARS)
  let final: Promise<{ committed: boolean }> | undefined
  for (let index = 0; index < total; index++) {
    const params = {
      key,
      writeId: 'one',
      index,
      total,
      value: value.slice(
        index * MOBILE_CHAT_DRAFT_CHUNK_CHARS,
        (index + 1) * MOBILE_CHAT_DRAFT_CHUNK_CHARS
      )
    }
    expect(
      isBridgeFrameWithinCap(
        JSON.stringify({ kind: 'request', method: 'native.storage.write', params })
      )
    ).toBe(true)
    if (index === total - 1) {
      final = writer.write(params)
    } else {
      expect(await writer.write(params)).toEqual({ committed: false })
    }
  }
  expect(disk.has(key)).toBe(false)
  release()
  expect(await final).toEqual({ committed: true })
  installNativeMobileChatDraftStorage()
  await hydrateMobileNativeChatDraft(scope)
  expect(readMobileNativeChatDraft(scope)).toMatchObject(JSON.parse(value))
  editMobileNativeChatDraft(scope, 'edited $review')
  await persistMobileNativeChatDraft(scope)
  resetMobileNativeChatDraftStoreForTests()
  await hydrateMobileNativeChatDraft(scope)
  expect(readMobileNativeChatDraft(scope)).toMatchObject({
    text: 'edited $review',
    images: JSON.parse(value).images,
    skills: JSON.parse(value).skills
  })
  await persistMirrored(other, value)
  await deleteMobileNativeChatDrafts('host', 'workspace')
  expect(disk.has(key)).toBe(false)
  expect(disk.has(other)).toBe(true)
  await deleteMobileNativeChatDrafts('host')
  expect(disk.has(other)).toBe(false)
  writer.dispose()
})

it('merges late hydration with new text and images and surfaces storage refusal', async () => {
  const scope = 'race\0workspace\0tab'
  let loaded: (value: string | null) => void = () => {}
  const read = new Promise<string | null>((resolve) => {
    loaded = resolve
  })
  const write = vi.fn(async () => {})
  publishMobileChatDraftStorage({ read: () => read, write, removeWorkspace: async () => {} })
  const hydration = hydrateMobileNativeChatDraft(scope)
  editMobileNativeChatDraft(scope, 'new typing')
  updateMobileNativeChatDraftImages(scope, (images) => [
    ...images,
    { id: 'new', path: '/host/new.png', previewUri: '' }
  ])
  loaded(JSON.stringify({ text: 'old', images: [{ id: 'saved', path: '/host/saved.png' }] }))
  await hydration
  await persistMobileNativeChatDraft(scope)
  expect(readMobileNativeChatDraft(scope).text).toBe('new typing')
  expect(readMobileNativeChatDraft(scope).images.map(({ id }) => id)).toEqual(['saved', 'new'])
  write.mockRejectedValueOnce(new Error('disk full'))
  await expect(persistMobileNativeChatDraft(scope)).rejects.toThrow('disk full')
  expect(readMobileNativeChatDraft(scope).images).toHaveLength(2)
})

it('orders acknowledged writes to one key while letting another key commit', async () => {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const held = vi.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (key, value) => {
    await gate
    disk.set(key, value)
  })
  const first = persistMirrored('ordered', 'first')
  const second = persistMirrored('ordered', 'second')
  await persistMirrored('independent', 'other')
  expect(disk.has('ordered')).toBe(false)
  expect(disk.get('independent')).toBe('other')
  release()
  await Promise.all([first, second])
  expect(disk.get('ordered')).toBe('second')
  held.mockRestore()
})

it('binds extracted files to their own text and permanently prunes deleted tokens across reload', async () => {
  installNativeMobileChatDraftStorage()
  const scope = 'skills\0workspace\0tab'
  const skills = [
    { name: 'review', path: '/one' },
    { name: 'review', path: '/two' }
  ]
  editMobileNativeChatDraft(scope, '$review existing')
  await copyMobileQueuedMessageToDraft(scope, {
    messageId: 'picked',
    position: 1,
    state: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: '$review' }], skills }
  })
  expect(readMobileNativeChatDraft(scope).skills).toEqual([skills[0]])
  editMobileNativeChatDraft(scope, 'no selection')
  editMobileNativeChatDraft(scope, '$review retyped')
  await persistMobileNativeChatDraft(scope)
  resetMobileNativeChatDraftStoreForTests()
  await hydrateMobileNativeChatDraft(scope)
  const draft = readMobileNativeChatDraft(scope)
  expect(draft.text).toBe('$review retyped')
  expect(structuredAgentSessionSendBody(draft.text, [], draft.skills).skills).toBeUndefined()
})
