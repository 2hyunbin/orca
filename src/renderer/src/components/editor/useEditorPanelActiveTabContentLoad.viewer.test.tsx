// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useEditorPanelActiveTabContentLoad } from './useEditorPanelActiveTabContentLoad'
import type { OpenFile } from '@/store/slices/editor'

vi.mock('./use-quick-open-history-visit', () => ({ useQuickOpenHistoryVisit: vi.fn() }))
const loadFile = vi.fn(async () => {})
const loadDiff = vi.fn(async () => {})
let root: Root
let container: HTMLDivElement
const file: OpenFile = {
  id: 'pending',
  filePath: '/folder/file.binary',
  relativePath: 'file.binary',
  worktreeId: 'folder',
  language: 'plaintext',
  mode: 'file-opening',
  isDirty: false,
  readOnly: true
}
function Harness({
  activeFile,
  visible = true
}: {
  activeFile: OpenFile
  visible?: boolean
}): null {
  useEditorPanelActiveTabContentLoad({
    activeFile,
    selectedConflictReviewFile: null,
    isVisible: visible,
    isChangesMode: false,
    gitStatusEntries: [],
    fileContents: {},
    diffContents: {},
    fileReadGenerationRef: { current: {} },
    outstandingFileReadsRef: { current: {} },
    diffReadGenerationRef: { current: {} },
    outstandingDiffReadsRef: { current: {} },
    loadFileContent: loadFile,
    loadDiffContent: loadDiff
  })
  return null
}
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
describe('text loading after file-viewer resolution', () => {
  it('does not read bytes for a waiting or parser surface and starts text loading only after a core choice', async () => {
    await act(async () => root.render(<Harness activeFile={file} />))
    expect(loadFile).not.toHaveBeenCalled()
    expect(loadDiff).not.toHaveBeenCalled()
    await act(async () =>
      root.render(<Harness activeFile={{ ...file, id: 'viewer', mode: 'plugin-viewer' }} />)
    )
    expect(loadFile).not.toHaveBeenCalled()
    await act(async () =>
      root.render(<Harness activeFile={{ ...file, id: 'core', mode: 'edit' }} />)
    )
    expect(loadFile).toHaveBeenCalledOnce()
    expect(loadFile).toHaveBeenCalledWith(file.filePath, 'core', file.worktreeId, file.relativePath)
  })
  it('does not begin a core read when resolution happens in a hidden pane', async () => {
    await act(async () => root.render(<Harness activeFile={file} visible={false} />))
    await act(async () =>
      root.render(<Harness activeFile={{ ...file, id: 'core', mode: 'edit' }} visible={false} />)
    )
    expect(loadFile).not.toHaveBeenCalled()
    expect(loadDiff).not.toHaveBeenCalled()
  })
})
