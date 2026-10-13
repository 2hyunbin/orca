import { describe, expect, it } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { pluginViewerSelectedFileAccess } from './plugin-viewer-selected-file-access'

const file: OpenFile = {
  id: 'viewer',
  filePath: '/outside/file.sample',
  relativePath: '/outside/file.sample',
  worktreeId: 'repo::/repo',
  language: 'plaintext',
  isDirty: false,
  mode: 'plugin-viewer',
  readOnly: true,
  runtimeEnvironmentId: 'hub',
  pluginViewerUserSelectedFile: true,
  operationProvenance: {
    ownershipProjection: 'explicit',
    generation: {
      route: { executionHostId: 'runtime:hub', runtimeEnvironmentId: 'hub' },
      runtimePairingRevision: 1,
      runtimeConnectionGeneration: null,
      runtimeSshGeneration: null,
      nestedSshGeneration: null,
      directSshGeneration: null
    }
  }
}
describe('viewer-only selected-file intent', () => {
  it('delegates a named viewer file without expanding ordinary editor authority', () => {
    expect(pluginViewerSelectedFileAccess({ settings: null }, file)).toEqual({ kind: 'user-file' })
    expect(editorTabFileAccess({ settings: null }, file)).toBeUndefined()
  })
  it.each([
    { pluginViewerUserSelectedFile: undefined },
    { readOnly: false },
    { mode: 'edit' as const },
    { operationProvenance: undefined },
    { relativePath: 'file.sample' }
  ])('refuses absent selection or a non-viewer intent: %j', (patch) => {
    expect(
      pluginViewerSelectedFileAccess({ settings: null }, { ...file, ...patch })
    ).toBeUndefined()
  })
})
