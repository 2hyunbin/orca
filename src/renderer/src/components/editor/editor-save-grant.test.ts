import { describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'

const grantRestoredHostFile = vi.hoisted(() => vi.fn())
vi.mock('./restored-host-file-grant', () => ({ grantRestoredHostFile }))

import { editorSaveGrant } from './editor-save-disk-precondition'

const PATH = '/private/tmp/handoff.md'
const hostContext: RuntimeFileOperationArgs = {
  target: { kind: 'environment', environmentId: 'env-1' },
  worktreeId: 'wt-1',
  worktreePath: '/srv/repo'
}

function tab(overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: PATH,
    filePath: PATH,
    relativePath: PATH,
    worktreeId: 'wt-1',
    language: 'markdown',
    isDirty: true,
    mode: 'edit',
    ...overrides
  }
}

describe('the grant an editor save writes through', () => {
  // Why: grants are never persisted, so a restored dirty tab that never loaded must still save.
  it('asks the host for a grant for a restored tab outside every workspace and keeps it', async () => {
    grantRestoredHostFile.mockResolvedValue({ grantId: 'g-2', readOnly: false })
    const setTerminalArtifactGrant = vi.fn()

    const grant = await editorSaveGrant(tab(), hostContext, () => ({ setTerminalArtifactGrant }))

    expect(grant?.grantId).toBe('g-2')
    expect(grantRestoredHostFile).toHaveBeenCalledWith(hostContext.target, 'wt-1', PATH)
    expect(setTerminalArtifactGrant).toHaveBeenCalledWith(PATH, 'g-2', false)
  })

  it('leaves workspace files and this computer’s files to the ordinary save', async () => {
    grantRestoredHostFile.mockClear()
    const getState = () => ({ setTerminalArtifactGrant: vi.fn() })

    await expect(
      editorSaveGrant(
        tab({ filePath: '/srv/repo/a.md', relativePath: '/srv/repo/a.md' }),
        hostContext,
        getState
      )
    ).resolves.toBeUndefined()
    await expect(
      editorSaveGrant(tab(), { ...hostContext, target: { kind: 'local' } }, getState)
    ).resolves.toBeUndefined()
    expect(grantRestoredHostFile).not.toHaveBeenCalled()
  })
})
