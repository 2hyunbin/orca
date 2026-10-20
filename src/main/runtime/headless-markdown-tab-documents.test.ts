import { describe, expect, it, vi } from 'vitest'
import {
  hashMarkdownContent,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  MOBILE_MARKDOWN_READ_MAX_BYTES
} from '../../shared/mobile-markdown-document'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { getDiskBaselineSignature } from '../../shared/disk-baseline-signature'
import { compareDiskWritePrecondition } from '../../shared/file-write-disk-precondition'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import {
  readHeadlessMarkdownTab,
  saveHeadlessMarkdownTab,
  type HeadlessMarkdownTabHost
} from './headless-markdown-tab-documents'

const WORKTREE = 'repo::/srv/repo'
const FILE_PATH = '/srv/repo/README.md'
const TAB = { id: FILE_PATH, filePath: FILE_PATH }

function makeHost(disk: string, draft?: string, saved: Partial<PersistedOpenFile> = {}) {
  const file: PersistedOpenFile = {
    filePath: FILE_PATH,
    relativePath: 'README.md',
    worktreeId: WORKTREE,
    language: 'markdown',
    runtimeEnvironmentId: null,
    ...(draft === undefined
      ? {}
      : { dirtyDraftContent: draft, lastKnownDiskSignature: getDiskBaselineSignature(disk) }),
    ...saved
  }
  let session: WorkspaceSessionState = {
    ...getDefaultWorkspaceSession(),
    openFilesByWorktree: { [WORKTREE]: [file] }
  }
  const state = { disk }
  const host = {
    getWorkspaceSessionForWorktree: () => session,
    setWorkspaceSessionForWorktree: vi.fn((_worktreeId: string, next: WorkspaceSessionState) => {
      session = next
    }),
    readFile: vi.fn(async (_worktreeId: string, _filePath: string, maxBytes: number) => {
      const bytes = Buffer.from(state.disk)
      return { content: bytes.subarray(0, maxBytes).toString('utf8'), byteLength: bytes.length }
    }),
    writeFileIfUnchanged: vi.fn(
      async (
        _worktreeId: string,
        _filePath: string,
        content: string,
        precondition: { expectedSignature: string }
      ) => {
        if (compareDiskWritePrecondition(precondition, state.disk)) {
          return { ok: false as const, diskConflict: 'changed' as const }
        }
        state.disk = content
        return { ok: true as const }
      }
    ),
    republishMobileSessionTabs: vi.fn()
  } satisfies HeadlessMarkdownTabHost
  return { host, state, session: () => session }
}

describe('headless Markdown tab documents', () => {
  it('reads the file from disk when the tab has no saved draft', async () => {
    const { host } = makeHost('# Notes\n')

    await expect(readHeadlessMarkdownTab(host, WORKTREE, TAB)).resolves.toEqual({
      tabId: FILE_PATH,
      filePath: FILE_PATH,
      relativePath: 'README.md',
      content: '# Notes\n',
      isDirty: false,
      version: hashMarkdownContent('# Notes\n'),
      source: 'file',
      editable: true
    })
  })

  it('reads a saved draft before the disk, as the editor shows it', async () => {
    const { host } = makeHost('# Disk\n', '# Draft\n')

    await expect(readHeadlessMarkdownTab(host, WORKTREE, TAB)).resolves.toMatchObject({
      content: '# Draft\n',
      isDirty: true,
      source: 'draft',
      version: hashMarkdownContent('# Draft\n')
    })
    expect(host.readFile).not.toHaveBeenCalled()
  })

  it('marks a file over the edit cap read-only, and a file over the read cap truncated', async () => {
    const editable = makeHost('a'.repeat(MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1))
    await expect(readHeadlessMarkdownTab(editable.host, WORKTREE, TAB)).resolves.toMatchObject({
      editable: false,
      readOnlyReason: 'file_too_large'
    })

    const size = MOBILE_MARKDOWN_READ_MAX_BYTES + 10
    const large = makeHost('a'.repeat(size))
    const read = await readHeadlessMarkdownTab(large.host, WORKTREE, TAB)
    expect(read).toMatchObject({ truncated: true, byteLength: size, editable: false })
    expect(Buffer.byteLength(read.content)).toBe(MOBILE_MARKDOWN_READ_MAX_BYTES)
    expect(read.version).toBe(hashMarkdownContent(read.content))
  })

  it('saves over the version the phone read, refusing any change on disk since', async () => {
    const { host, state } = makeHost('# Notes\n')

    await expect(
      saveHeadlessMarkdownTab(host, WORKTREE, TAB, hashMarkdownContent('# Notes\n'), '# New\n')
    ).resolves.toEqual({
      tabId: FILE_PATH,
      version: hashMarkdownContent('# New\n'),
      isDirty: false,
      content: '# New\n'
    })
    expect(state.disk).toBe('# New\n')
    expect(host.writeFileIfUnchanged).toHaveBeenCalledWith(WORKTREE, FILE_PATH, '# New\n', {
      expectedSignature: getDiskBaselineSignature('# Notes\n')
    })
  })

  it('refuses a save from a stale version and leaves the disk alone', async () => {
    const { host, state } = makeHost('# Changed on the server\n')

    await expect(
      saveHeadlessMarkdownTab(host, WORKTREE, TAB, hashMarkdownContent('# Notes\n'), '# Phone\n')
    ).rejects.toThrow('conflict')
    expect(state.disk).toBe('# Changed on the server\n')
    expect(host.writeFileIfUnchanged).not.toHaveBeenCalled()
  })

  it('answers a repeated save that already landed as saved', async () => {
    const { host } = makeHost('# New\n')

    await expect(
      saveHeadlessMarkdownTab(host, WORKTREE, TAB, hashMarkdownContent('# Notes\n'), '# New\n')
    ).resolves.toMatchObject({ content: '# New\n', isDirty: false })
    expect(host.writeFileIfUnchanged).not.toHaveBeenCalled()
  })

  it('refuses when the disk changes between the read and the write', async () => {
    const { host, state } = makeHost('# Notes\n')
    host.readFile.mockImplementationOnce(async () => {
      const read = { content: state.disk, byteLength: Buffer.byteLength(state.disk) }
      state.disk = '# Raced\n'
      return read
    })

    await expect(
      saveHeadlessMarkdownTab(host, WORKTREE, TAB, hashMarkdownContent('# Notes\n'), '# Phone\n')
    ).rejects.toThrow('conflict')
    expect(state.disk).toBe('# Raced\n')
  })

  it('saves over a saved draft, then clears the draft and lists the tab clean', async () => {
    const { host, state, session } = makeHost('# Disk\n', '# Draft\n')

    await saveHeadlessMarkdownTab(
      host,
      WORKTREE,
      TAB,
      hashMarkdownContent('# Draft\n'),
      '# Phone\n'
    )

    expect(state.disk).toBe('# Phone\n')
    const [file] = session().openFilesByWorktree?.[WORKTREE] ?? []
    expect(file).not.toHaveProperty('dirtyDraftContent')
    expect(file).not.toHaveProperty('lastKnownDiskSignature')
    expect(host.republishMobileSessionTabs).toHaveBeenCalledWith(WORKTREE)
  })

  it('runs two saves of one file one after the other', async () => {
    const { host, state } = makeHost('# Notes\n')
    const base = hashMarkdownContent('# Notes\n')

    // Run together, the second would pass the same version check and fail the disk precondition.
    const results = await Promise.all([
      saveHeadlessMarkdownTab(host, WORKTREE, TAB, base, '# Same\n'),
      saveHeadlessMarkdownTab(host, WORKTREE, TAB, base, '# Same\n')
    ])

    expect(results.map((result) => result.content)).toEqual(['# Same\n', '# Same\n'])
    expect(host.writeFileIfUnchanged).toHaveBeenCalledTimes(1)
    expect(state.disk).toBe('# Same\n')
  })

  it('keeps saving after a failed save of the same file', async () => {
    const { host, state } = makeHost('# Notes\n')
    host.writeFileIfUnchanged.mockRejectedValueOnce(new Error('EACCES'))
    const base = hashMarkdownContent('# Notes\n')

    await expect(saveHeadlessMarkdownTab(host, WORKTREE, TAB, base, '# First\n')).rejects.toThrow(
      'EACCES'
    )
    await saveHeadlessMarkdownTab(host, WORKTREE, TAB, base, '# Second\n')

    expect(state.disk).toBe('# Second\n')
  })

  it('refuses to save a draft over a disk edit made after the draft', async () => {
    const { host, state, session } = makeHost('# Disk\n', '# Draft\n')
    state.disk = '# Edited on the server\n'

    await expect(
      saveHeadlessMarkdownTab(host, WORKTREE, TAB, hashMarkdownContent('# Draft\n'), '# Phone\n')
    ).rejects.toThrow('conflict')
    expect(state.disk).toBe('# Edited on the server\n')
    expect(session().openFilesByWorktree?.[WORKTREE]?.[0]?.dirtyDraftContent).toBe('# Draft\n')
  })

  it('never saves a read-only tab', async () => {
    const { host } = makeHost('# Log\n', undefined, { readOnly: true })

    await expect(readHeadlessMarkdownTab(host, WORKTREE, TAB)).resolves.toMatchObject({
      editable: false,
      readOnlyReason: 'unsupported_tab'
    })
    await expect(
      saveHeadlessMarkdownTab(host, WORKTREE, TAB, hashMarkdownContent('# Log\n'), '# Edit\n')
    ).rejects.toThrow('unsupported_tab')
    expect(host.writeFileIfUnchanged).not.toHaveBeenCalled()
  })

  it('refuses a tab the saved session no longer holds', async () => {
    const { host } = makeHost('# Notes\n')

    await expect(
      readHeadlessMarkdownTab(host, WORKTREE, { id: 'gone', filePath: '/srv/repo/GONE.md' })
    ).rejects.toThrow('tab_not_found')
  })
})
