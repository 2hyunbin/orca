// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useCallback } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resolveNativeChatDraftOwner } from '@/lib/native-chat-draft-owner'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { useAgentMessageSenderLabel } from './native-chat-agent-message-sender-label'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useRestoredNativeChatComposerDraftImageCheck } from './native-chat-composer-draft-image-check'
import * as drafts from './native-chat-composer-draft-store'
import * as storage from './native-chat-composer-draft-storage'
import { resetStructuredAgentSessionStatusFeedsForTests } from '@/runtime/structured-agent-session-status-feed'

const initial = useAppStore.getInitialState()
const originalApi = window.api
const reads = { terminal: 0, unified: 0 }
let renders = 0
const workspace = (index: number) => `folder:workspace-${index}`
const scope = (index: number) => `agent-session:session-${index}`
function counted<T extends object>(map: T, kind: keyof typeof reads): T {
  return new Proxy(map, { ownKeys: (target) => (reads[kind]++, Reflect.ownKeys(target)) })
}
function tab(index: number): Tab {
  return {
    id: `chat-${index}`,
    entityId: `session-${index}`,
    worktreeId: workspace(index % 60),
    groupId: 'group',
    contentType: 'agent-session',
    executionHostId: 'local',
    label: `Chat ${index}`,
    customLabel: `Name ${index}`,
    color: null,
    sortOrder: index,
    createdAt: 0
  }
}
function seed() {
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  const unifiedTabsByWorktree: Record<string, Tab[]> = {}
  const folderWorkspaces: FolderWorkspace[] = []
  for (let index = 0; index < 60; index++) {
    const id = workspace(index)
    tabsByWorktree[id] = Array.from({ length: 16 }, (_, slot) => ({
      id: `terminal-${index}-${slot}`,
      worktreeId: id,
      ptyId: null,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: slot,
      createdAt: 0
    }))
    unifiedTabsByWorktree[id] = []
    folderWorkspaces.push({
      id: `workspace-${index}`,
      projectGroupId: 'group',
      name: id,
      folderPath: `/repo/${index}`,
      executionHostId: 'local',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: index,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    })
  }
  for (let index = 0; index < 100; index++) {
    unifiedTabsByWorktree[workspace(index % 60)].push(tab(index))
  }
  useAppStore.setState(
    {
      ...initial,
      folderWorkspaces,
      tabsByWorktree: counted(tabsByWorktree, 'terminal'),
      unifiedTabsByWorktree: counted(unifiedTabsByWorktree, 'unified')
    },
    true
  )
}

function Sender({ index }: { index: number }) {
  renders++
  const name = useAgentMessageSenderLabel(
    {
      party: {
        address: `sender-${index}`,
        terminalHandle: null,
        orcaSessionId: `session-${index}`
      },
      name: 'Recorded'
    },
    workspace(index % 60),
    { kind: 'local' }
  )
  return <output data-index={index}>{name}</output>
}
function FileLink({ index }: { index: number }) {
  renders++
  const context = useNativeChatFileLinkContext(`chat-${index}`)
  return <output data-index={index}>{context?.worktreeId}</output>
}
function Composer({ index }: { index: number }) {
  renders++
  const subscribe = useCallback(
    (listener: () => void) => drafts.subscribeToNativeChatComposerDraft(scope(index), listener),
    [index]
  )
  const pending = useRestoredNativeChatComposerDraftImageCheck(scope(index), subscribe)
  return <output data-index={index}>{pending.size}</output>
}

afterEach(() => {
  cleanup()
  drafts.clearNativeChatComposerDraftsForTests()
  resetStructuredAgentSessionStatusFeedsForTests()
  useAppStore.setState(initial, true)
  Object.assign(window, { api: originalApi })
})

it.each([
  { name: 'sender', Subscriber: Sender },
  { name: 'file link', Subscriber: FileLink },
  { name: 'composer', Subscriber: Composer }
])('$name subscribers share the tab-map scan budget at 100 chats', async ({ name, Subscriber }) => {
  seed()
  const resolveOwner = vi.fn((key: string) =>
    resolveNativeChatDraftOwner(useAppStore.getState(), key)
  )
  drafts.setNativeChatComposerDraftOwnerResolver(resolveOwner)
  const saved = storage.createMemoryNativeChatComposerDraftStorage()
  saved.drafts.set(scope(0), {
    text: '',
    owner: { workspaceId: workspace(0), executionHostId: 'local' },
    savedAt: 1,
    images: [{ id: 'image', path: '/state/agent-session-attachments/upload/shot.png' }]
  })
  storage.setNativeChatComposerDraftStorageForTests(saved)
  const validation = Promise.withResolvers<boolean>()
  const pathExists = vi.fn(() => validation.promise)
  Object.assign(window, { api: { fs: { pathExists } } })
  await drafts.hydrateNativeChatComposerDrafts()
  const view = render(
    <>
      {Array.from({ length: 100 }, (_, index) => (
        <Subscriber key={index} index={index} />
      ))}
    </>
  )
  if (name === 'composer') {
    expect(pathExists).toHaveBeenCalledTimes(1)
    expect(view.container.querySelector('[data-index="0"]')?.textContent).toBe('1')
  }
  reads.terminal = reads.unified = renders = 0
  resolveOwner.mockClear()
  act(() => {
    for (let tick = 0; tick < 50; tick++) {
      useAppStore.setState({ lastTerminalInputAtByPaneKey: { 'other:pane': tick } })
    }
  })
  expect(reads).toEqual({ terminal: 0, unified: 0 })
  expect(renders).toBe(0)
  expect(resolveOwner).not.toHaveBeenCalled()

  // Build the focus/relabel publication before counting subscriber work on the new snapshot.
  const state = useAppStore.getState()
  const moved = { ...tab(0), worktreeId: workspace(1), customLabel: 'Renamed' }
  const replacement = counted(
    {
      ...state.unifiedTabsByWorktree,
      [workspace(0)]: state.unifiedTabsByWorktree[workspace(0)].filter(({ id }) => id !== moved.id),
      [workspace(1)]: [...state.unifiedTabsByWorktree[workspace(1)], moved]
    },
    'unified'
  )
  const terminals = counted({ ...state.tabsByWorktree }, 'terminal')
  reads.terminal = reads.unified = 0
  await act(async () =>
    useAppStore.setState({
      unifiedTabsByWorktree: replacement,
      tabsByWorktree: terminals,
      activeWorktreeId: workspace(1)
    })
  )
  expect(reads.terminal).toBeLessThanOrEqual(1)
  expect(reads.unified).toBeLessThanOrEqual(1)
  expect(resolveNativeChatDraftOwner(useAppStore.getState(), scope(0))?.workspaceId).toBe(
    workspace(1)
  )
  expect(view.container.querySelector('[data-index="0"]')?.textContent).toBe(
    name === 'sender' ? 'Renamed' : name === 'file link' ? workspace(1) : '1'
  )
  await act(async () => validation.resolve(true))
})
