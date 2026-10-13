// @vitest-environment happy-dom
import { act, useMemo, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { FileContent } from './editor-panel-content-types'

const mocks = vi.hoisted(() => ({ read: vi.fn(), resolveOwner: vi.fn(), getState: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', () => ({
  getRuntimeFileReadScope: vi.fn(() => null),
  readRuntimeFileContent: mocks.read,
  subscribeRuntimeFileChanges: vi.fn()
}))
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitBranchDiff: vi.fn(),
  getRuntimeGitCommitDiff: vi.fn(),
  getRuntimeGitDiff: vi.fn(),
  getRuntimeGitScope: vi.fn(() => null)
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(),
  getConnectionIdForFile: mocks.resolveOwner,
  isWorktreeConnectionResolved: vi.fn(() => true)
}))
vi.mock('@/lib/worktree-host-connection-phase', () => import('./local-host-test-fixture'))
vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: vi.fn(() => null)
}))
vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))

import { useEditorPanelContentState } from './useEditorPanelContentState'
import {
  useEditorPanelFileContentLoader,
  type EditorPanelFileContentLoader
} from './useEditorPanelFileContentLoader'

const input: OpenFile = {
  id: 'owned-file',
  filePath: '/repo/file.binary',
  relativePath: 'file.binary',
  worktreeId: 'wt-1',
  language: 'plaintext',
  mode: 'file-opening',
  isDirty: false,
  readOnly: true
}
let root: Root
let container: HTMLDivElement
let reload: (file: OpenFile) => void
let load: EditorPanelFileContentLoader
let contents: Record<string, FileContent>
const generations: { current: Record<string, number> } = { current: {} }
const outstanding: { current: Record<string, number> } = { current: {} }
const counter = { current: 0 }
function ContentProbe({ file }: { file: OpenFile }): null {
  const openFiles = useMemo(() => [file], [file])
  const state = useEditorPanelContentState({
    activeFile: file,
    openFiles,
    isChangesMode: false,
    gitStatusEntries: undefined,
    editorViewMode: {}
  })
  reload = state.reloadContent
  contents = state.fileContents
  return null
}
function LoaderProbe({ file }: { file: OpenFile }): null {
  const openFilesRef = useRef([file])
  openFilesRef.current = [file]
  const [, setFileContents] = useState<Record<string, FileContent>>({})
  load = useEditorPanelFileContentLoader({
    fileLoadRetryAttemptsRef: useRef({}),
    fileReadGenerationCounterRef: counter,
    fileReadGenerationRef: generations,
    openFilesRef,
    outstandingFileReadsRef: outstanding,
    setFileContents
  })
  return null
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { onLocalLogTailChanged: vi.fn(() => () => {}) } }
  })
  mocks.getState.mockReturnValue({
    settings: null,
    openFiles: [],
    setLastKnownDiskSignature: vi.fn()
  })
  mocks.read.mockResolvedValue({ content: 'explicit core content', isBinary: false })
  counter.current = 0
  generations.current = {}
  outstanding.current = {}
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
describe('viewer files never enter the text reader', () => {
  it.each(['file-opening', 'plugin-viewer'] as const)(
    'withholds bytes from normal and explicit reloads of a %s surface',
    async (mode) => {
      const file = { ...input, mode }
      await act(async () => root.render(<ContentProbe file={file} />))
      await act(async () => reload(file))
      expect(mocks.read).not.toHaveBeenCalled()
      expect(mocks.resolveOwner).not.toHaveBeenCalled()
      expect(contents).toEqual({})
      await act(async () => root.render(<ContentProbe file={{ ...file, mode: 'edit' }} />))
      expect(mocks.read).toHaveBeenCalledOnce()
      expect(contents[input.id]?.content).toBe('explicit core content')
    }
  )
  it.each(['file-opening', 'plugin-viewer'] as const)(
    'fences a direct forced loader call for the current %s tab before RPC or read generations',
    async (mode) => {
      await act(async () => root.render(<LoaderProbe file={{ ...input, mode }} />))
      await act(async () =>
        load(input.filePath, input.id, input.worktreeId, input.relativePath, { force: true })
      )
      expect(mocks.read).not.toHaveBeenCalled()
      expect(mocks.resolveOwner).not.toHaveBeenCalled()
      expect(counter.current).toBe(0)
      expect(generations.current).toEqual({})
      expect(outstanding.current).toEqual({})
    }
  )
})
