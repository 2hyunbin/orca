import { describe, expect, it } from 'vitest'
import { buildOwnedEditorFileId } from './editor-file-ids'
import { pluginViewerFileId } from './plugin-viewer-file-id'

describe('qualified viewer tab identity', () => {
  it('cannot collide with an editor or another viewer for the same file', () => {
    const file = '/workspace/file.binary'
    const ids = [
      buildOwnedEditorFileId(file, 'folder:one', null),
      file,
      pluginViewerFileId(file, 'folder:one', null, 'viewer:one.package/sample'),
      pluginViewerFileId(file, 'folder:one', null, 'viewer:two.package/sample')
    ]
    expect(new Set(ids).size).toBe(ids.length)
  })
  it('keeps workspace and execution-host ownership across reopen and restart', () => {
    const key = 'viewer:community.viewer/sample'
    const native = pluginViewerFileId('C:\\workspace\\file', 'folder:one', null, key)
    expect(native).toBe(pluginViewerFileId('C:\\workspace\\file', 'folder:one', undefined, key))
    expect(native).not.toBe(pluginViewerFileId('C:\\workspace\\file', 'folder:two', null, key))
    expect(native).not.toBe(pluginViewerFileId('C:\\workspace\\file', 'folder:one', 'remote', key))
  })
})
