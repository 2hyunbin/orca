import { expect, it } from 'vitest'
import { persistedOpenFileSchema } from '../workspace-session-editor-schema'
import { resolvePluginViewerSourceView } from './plugin-viewer-source-view'

it('preserves readonly log intent across viewer changes and serialized restoration', () => {
  const source = resolvePluginViewerSourceView({ mode: 'edit', readOnly: true, liveTail: true })
  const record = persistedOpenFileSchema.parse({
    filePath: '/workspace/log',
    relativePath: 'log',
    worktreeId: 'folder',
    language: 'plaintext',
    pluginViewer: { key: 'viewer:community.logs/tail', sourceView: source }
  })
  const next = resolvePluginViewerSourceView({
    mode: 'plugin-viewer',
    pluginViewer: record.pluginViewer
  })
  expect(next).toEqual({ readOnly: true, liveTail: true })
  expect(
    resolvePluginViewerSourceView({ mode: 'plugin-viewer', pluginViewer: { sourceView: next } })
  ).toEqual(source)
})

it('retains ordinary writable source intent while the parser view remains readonly', () => {
  const sourceView = resolvePluginViewerSourceView({ mode: 'edit' })
  expect(
    resolvePluginViewerSourceView({
      mode: 'plugin-viewer',
      readOnly: true,
      pluginViewer: { sourceView }
    })
  ).toEqual({ readOnly: false })
})

it('uses a readonly fallback for old sessions and never tails a writable source', () => {
  expect(resolvePluginViewerSourceView({ mode: 'plugin-viewer' })).toEqual({ readOnly: true })
  expect(resolvePluginViewerSourceView({ mode: 'edit', liveTail: true })).toEqual({
    readOnly: false
  })
  expect(
    resolvePluginViewerSourceView({
      mode: 'plugin-viewer',
      pluginViewer: { sourceView: { readOnly: false, liveTail: true } }
    })
  ).toEqual({ readOnly: false })
})

it('rejects executable or file-authority fields in saved source state', () => {
  expect(
    persistedOpenFileSchema.safeParse({
      filePath: '/workspace/log',
      relativePath: 'log',
      worktreeId: 'folder',
      language: 'plaintext',
      pluginViewer: {
        key: 'viewer:community.logs/tail',
        sourceView: { readOnly: true, filePath: '/private/secret', worker: 'execute' }
      }
    }).success
  ).toBe(false)
})
