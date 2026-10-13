import { describe, expect, it } from 'vitest'
import {
  PLUGIN_VIEWER_SAVED_VIEWS,
  pluginViewerTabViewportsSchema,
  pluginViewerViewportForTab,
  withPluginViewerTabViewport
} from './plugin-viewer-view-state'
import { persistedOpenFileSchema } from '../workspace-session-editor-schema'

const first = { kind: 'text' as const, startLine: 0, lineCount: 64 }
const second = { ...first, startLine: 64 }
describe('viewer viewport ownership by pane tab', () => {
  it('keeps separate positions for two panes of the same document and a fresh position for a new pane', () => {
    const left = withPluginViewerTabViewport({}, 'left', first)
    const both = withPluginViewerTabViewport(left, 'right', second)
    expect(pluginViewerViewportForTab(both, 'left')).toEqual(first)
    expect(pluginViewerViewportForTab(both, 'right')).toEqual(second)
    expect(pluginViewerViewportForTab(both, 'new-pane')).toBeUndefined()
    expect(pluginViewerViewportForTab({ viewport: second }, 'legacy-pane')).toEqual(second)
  })
  it('bounds saved views and refreshes the most recently used position', () => {
    let state = withPluginViewerTabViewport({}, 'keep', first)
    for (let index = 0; index < PLUGIN_VIEWER_SAVED_VIEWS - 1; index++) {
      state = withPluginViewerTabViewport(state, `pane-${index}`, first)
    }
    state = withPluginViewerTabViewport(state, 'keep', second)
    state = withPluginViewerTabViewport(state, 'latest', first)
    expect(Object.keys(state.viewportsByTab ?? {})).toHaveLength(PLUGIN_VIEWER_SAVED_VIEWS)
    expect(pluginViewerViewportForTab(state, 'keep')).toEqual(second)
    expect(pluginViewerViewportForTab(state, 'pane-0')).toBeUndefined()
    expect(pluginViewerTabViewportsSchema.safeParse(state.viewportsByTab).success).toBe(true)
  })
  it('validates the whole persisted map and rejects excessive, malformed or inherited positions', () => {
    expect(
      pluginViewerTabViewportsSchema.safeParse({ pane: { ...first, startLine: -1 } }).success
    ).toBe(false)
    expect(
      pluginViewerTabViewportsSchema.safeParse(
        Object.fromEntries(
          Array.from({ length: PLUGIN_VIEWER_SAVED_VIEWS + 1 }, (_, i) => [i, first])
        )
      ).success
    ).toBe(false)
    expect(
      pluginViewerViewportForTab({ viewportsByTab: { left: first } }, 'toString')
    ).toBeUndefined()
    const parsed = persistedOpenFileSchema.parse({
      filePath: '/folder/file.binary',
      relativePath: 'file.binary',
      worktreeId: 'folder',
      language: 'plaintext',
      pluginViewerOwnerExpired: true,
      pluginViewer: {
        key: 'viewer:community.viewer/sample',
        viewportsByTab: { left: first, right: second }
      }
    })
    expect(parsed.pluginViewer?.viewportsByTab).toEqual({ left: first, right: second })
    expect(parsed).not.toHaveProperty('pluginViewerOwnerExpired')
  })
})
