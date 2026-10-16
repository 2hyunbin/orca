// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { openNativeChatLocalDraft } from './native-chat-local-draft'
import { newAgentLaunchRequestId } from './agent-launch-request-id'
import { allocateNativeChatNewDraft, invalidateNativeChatNewDraft, deleteNativeChatNewDraftsOwnedBy, readNativeChatNewDraft, retireNativeChatNewDraft, updateNativeChatNewDraft } from '@/components/native-chat/native-chat-new-draft'
import { clearNativeChatComposerDraftsForTests, hydrateNativeChatComposerDrafts, isNativeChatComposerDraftUnsaved, readNativeChatComposerDraft, updateNativeChatComposerDraft } from '@/components/native-chat/native-chat-composer-draft-store'
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
    const quiet = openNativeChatLocalDraft({ ...args, requestId: newAgentLaunchRequestId(), activate: false })
    expect(quiet?.entityId).not.toBe(tab?.entityId)
    expect(quiet?.groupId).toBe('split-right')
    expect(readNativeChatComposerDraft(`agent-session:${quiet?.entityId}`).text).toBe('unique marker')
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


it('converges foreign retirement during a pick and adopts a recreated workspace draft', async () => {
  const id = 'codex_foreign_retirement'
  const key = `agent-session-new:${id}`
  const metadata = { owner: { workspaceId: 'folder:workspace', executionHostId: 'local' as const }, agent: 'codex' as const, groupId: 'group-1', options: {} }
  allocateNativeChatNewDraft(id, metadata)
  await vi.waitFor(async () => expect(await storage.read(key)).toEqual(metadata))
  const update = storage.update
  let commit: (() => void) | undefined
  storage.update = (scope, apply) => new Promise((resolve) => {
    commit = () => { void update(scope, apply).then(resolve) }
  })
  updateNativeChatNewDraft(id, { options: { model: 'pick during removal' } })
  await vi.waitFor(() => expect(commit).toBeDefined())
  await storage.remove([key])
  invalidateNativeChatNewDraft(key)
  commit?.()
  await vi.waitFor(() => expect(readNativeChatNewDraft(id)).toBeUndefined())
  storage.update = update
  allocateNativeChatNewDraft('codex_old_owner', metadata)
  deleteNativeChatNewDraftsOwnedBy(metadata.owner)
  await vi.waitFor(async () => expect(await storage.read('agent-session-new:codex_old_owner')).toBeUndefined())
  await storage.write('agent-session-new:codex_recreated_owner', metadata)
  invalidateNativeChatNewDraft('agent-session-new:codex_recreated_owner')
  await vi.waitFor(() => expect(readNativeChatNewDraft('codex_recreated_owner')).toEqual(metadata))
  const read = storage.read
  let releaseRead: (() => void) | undefined
  storage.read = async (scope) => {
    const snapshot = await read(scope)
    storage.read = read
    return new Promise((resolve) => { releaseRead = () => resolve(snapshot) })
  }
  invalidateNativeChatNewDraft('agent-session-new:codex_recreated_owner')
  await vi.waitFor(() => expect(releaseRead).toBeDefined())
  updateNativeChatNewDraft('codex_recreated_owner', { options: { model: 'newer than foreign read' } })
  await vi.waitFor(async () => expect(await read('agent-session-new:codex_recreated_owner')).toMatchObject({ options: { model: 'newer than foreign read' } }))
  releaseRead?.()
  await vi.waitFor(() => expect(readNativeChatNewDraft('codex_recreated_owner')?.options.model).toBe('newer than foreign read'))
  storage.refuseWrites = true
  allocateNativeChatNewDraft('codex_unsaved', metadata)
  invalidateNativeChatNewDraft('agent-session-new:codex_unsaved')
  await vi.waitFor(() => expect(isNativeChatComposerDraftUnsaved('agent-session:codex_unsaved')).toBe(true))
  expect(readNativeChatNewDraft('codex_unsaved')).toEqual(metadata)
  storage.refuseWrites = false
  await storage.write('agent-session-new:codex_unsaved', { ...metadata, options: { model: 'foreign committed row' } })
  invalidateNativeChatNewDraft('agent-session-new:codex_unsaved')
  await vi.waitFor(() => expect(readNativeChatNewDraft('codex_unsaved')?.options.model).toBe('foreign committed row'))
  await storage.remove(['agent-session-new:codex_unsaved'])
  invalidateNativeChatNewDraft('agent-session-new:codex_unsaved')
  await vi.waitFor(() => expect(readNativeChatNewDraft('codex_unsaved')).toBeUndefined())
  expect(mocks.call).not.toHaveBeenCalled()
})
