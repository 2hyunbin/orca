// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { openNativeChatLocalDraft } from './native-chat-local-draft'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { allocateNativeChatNewDraft, readNativeChatNewDraft, retireNativeChatNewDraft, updateNativeChatNewDraft } from '@/components/native-chat/native-chat-new-draft'
import { clearNativeChatComposerDraftsForTests, hydrateNativeChatComposerDrafts, readNativeChatComposerDraft, updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
import { createMemoryNativeChatComposerDraftStorage, setNativeChatComposerDraftStorageForTests } from '@/components/native-chat/native-chat-composer-draft-storage'

const mocks = vi.hoisted(() => { const tabs: Tab[] = []; return { tabs, focus: vi.fn(), call: vi.fn() } })
vi.mock('@/components/native-chat/use-native-chat-composer-reveal-focus', () => ({ requestNativeChatComposerFocus: mocks.focus }))
vi.mock('@/runtime/structured-agent-session-client', () => ({ callStructuredAgentSession: mocks.call }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({
  unifiedTabsByWorktree: { 'folder:workspace': mocks.tabs },
  focusGroup: vi.fn(), activateTab: vi.fn(), setActiveTabType: vi.fn(),
  createUnifiedTab: (worktreeId: string, contentType: Tab['contentType'], args: Partial<Tab> & { targetGroupId?: string }) => {
    const tab: Tab = { id: '', entityId: '', worktreeId, groupId: args.targetGroupId ?? 'group-1', contentType,
      label: '', customLabel: null, color: null, sortOrder: 0, createdAt: 1, ...args }
    mocks.tabs.push(tab)
    return tab
  }
}) } }))
let storage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>
beforeEach(async () => {
  vi.clearAllMocks()
  mocks.tabs.length = 0
  clearNativeChatComposerDraftsForTests()
  storage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
})
afterEach(() => clearNativeChatComposerDraftsForTests())

it.each(['claude', 'codex', 'grok', 'opencode', 'pi'] as const)(
  'opens a quiet folder draft or explicit split destination without asking the %s host', (agent) => {
    const requestId = newAgentLaunchRequestId()
    const args = { requestId, worktreeId: 'folder:workspace', executionHostId: 'local' as const, agent, groupId: 'split-right', prompt: 'unique marker' }
    const tab = openNativeChatLocalDraft(args)
    expect(tab).toMatchObject({ groupId: 'split-right', executionHostId: 'local', agentSessionAgent: agent })
    expect(readNativeChatComposerDraft(`agent-session:${tab?.entityId}`).text).toBe('unique marker')
    expect(readNativeChatNewDraft(tab?.entityId ?? '')).toMatchObject({ owner: { workspaceId: 'folder:workspace', executionHostId: 'local' }, groupId: 'split-right', agent })
    expect(mocks.focus).toHaveBeenCalledExactlyOnceWith(tab?.id)
    expect(openNativeChatLocalDraft(args)?.id).toBe(tab?.id)
    expect(mocks.tabs).toHaveLength(1)
    expect(mocks.call).not.toHaveBeenCalled()
    mocks.focus.mockClear()
    openNativeChatLocalDraft({ ...args, requestId: newAgentLaunchRequestId(), activate: false })
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(mocks.call).not.toHaveBeenCalled()
  }
)

it('keeps metadata independent of stale content and refuses to resurrect it after committed retirement', async () => {
  const id = 'codex_reload'
  const owner: { workspaceId: string; executionHostId: ExecutionHostId } = { workspaceId: 'folder:workspace', executionHostId: 'local' }
  const metadata = { owner, agent: 'codex' as const, groupId: 'split-down', options: { model: 'picked' } }
  allocateNativeChatNewDraft(id, metadata)
  updateNativeChatComposerDraft(`agent-session:${id}`, { text: 'saved', document: { type: 'doc' }, images: [{ id: 'image', path: '/source/image.png' }] }, 'immediate')
  await Promise.resolve()
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  expect(readNativeChatNewDraft(id)).toEqual(metadata)
  expect(readNativeChatComposerDraft(`agent-session:${id}`)).toMatchObject({ text: 'saved', images: [{ id: 'image', path: '/source/image.png' }] })
  storage.refuseWrites = true
  expect(await retireNativeChatNewDraft(id)).toBe(false)
  expect(readNativeChatNewDraft(id)).toEqual(metadata)
  storage.refuseWrites = false
  expect(await retireNativeChatNewDraft(id)).toBe(true)
  await storage.update(`agent-session-new:${id}`, (stored) => stored ? metadata : null)
  await storage.write(`agent-session:${id}`, { text: 'stale window', images: [], savedAt: 1 })
  updateNativeChatNewDraft(id, { options: { model: 'stale pick' } })
  clearNativeChatComposerDraftsForTests()
  setNativeChatComposerDraftStorageForTests(storage)
  await hydrateNativeChatComposerDrafts()
  expect(readNativeChatNewDraft(id)).toBeUndefined()
  expect(readNativeChatComposerDraft(`agent-session:${id}`).text).toBe('stale window')
  expect(mocks.call).not.toHaveBeenCalled()
})
