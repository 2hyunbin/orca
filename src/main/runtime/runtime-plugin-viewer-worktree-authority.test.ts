import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import * as worktreeGit from '../git/worktree'
import { deferred } from '../../shared/plugins/plugin-viewer-document-test-fixture'
import { createRuntimeViewerDocumentFixture } from './runtime-plugin-viewer-document-test-fixture'

const fixtures: Awaited<ReturnType<typeof createRuntimeViewerDocumentFixture>>[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    await f.documents.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})
async function fixture(git = true) {
  const f = await createRuntimeViewerDocumentFixture()
  fixtures.push(f)
  if (git) {
    const result = await runProcess({
      program: 'git',
      args: ['init', f.workspace],
      cwd: f.root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 10000,
      maxOutputBytes: 4096
    })
    if (result.code !== 0) {
      throw new Error('fixture Git initialization failed')
    }
    f.setRepos([
      {
        id: 'folder-repo',
        path: f.workspace,
        displayName: 'Host repository',
        badgeColor: 'blue',
        addedAt: 1,
        kind: 'git',
        executionHostId: 'local'
      }
    ])
  }
  return f
}

describe('runtime viewer authority on the host-owned Git registration', () => {
  it('opens actual binary ranges after confirming the current Git worktree', async () => {
    const f = await fixture()
    const listed = vi.spyOn(worktreeGit, 'listWorktreesStrict')
    const opened = await f.documents.open(f.input, f.transport())
    if (!opened.ok) {
      throw new Error('host document was not admitted')
    }
    expect(listed).toHaveBeenCalledWith(f.workspace, undefined)
    const { filePath: _filePath, ...lease } = f.input
    expect(
      await f.documents.read(
        {
          ...lease,
          request: {
            documentHandle: opened.document.documentHandle,
            revision: opened.document.revision,
            position: 0,
            length: 4
          }
        },
        f.transport()
      )
    ).toMatchObject({
      ok: true,
      result: {
        contentBase64: Buffer.from([0, 128, 255, 42]).toString('base64')
      }
    })
  })
  it('rejects a saved target path absent from Git rather than trusting degraded discovery', async () => {
    const f = await fixture()
    f.setTarget({ ...f.getTarget(), worktree: { ...f.getTarget().worktree, path: f.root } })
    expect(await f.documents.open(f.input, f.transport())).toEqual({
      ok: false,
      error: 'unauthorized'
    })
  })
  it('reports unreadable Git authority without substituting saved worktrees', async () => {
    const f = await fixture()
    vi.spyOn(worktreeGit, 'listWorktreesStrict').mockRejectedValue(new Error('Git unreachable'))
    expect(await f.documents.open(f.input, f.transport())).toEqual({
      ok: false,
      error: 'unavailable'
    })
  })
  it('uses the project runtime options selected on the execution host', async () => {
    const f = await fixture()
    vi.spyOn(f.host, 'resolveRuntimeGitTarget').mockResolvedValue({
      ...f.getTarget(),
      localGitOptions: { wslDistro: 'Ubuntu' }
    })
    const listed = vi
      .spyOn(worktreeGit, 'listWorktreesStrict')
      .mockResolvedValue([f.getTarget().worktree.git])
    expect((await f.documents.open(f.input, f.transport())).ok).toBe(true)
    expect(listed).toHaveBeenCalledWith(f.workspace, { wslDistro: 'Ubuntu' })
  })
  it.each(['ssh:other', 'runtime:other'] as const)(
    'refuses a Git target on %s without reading this host',
    async (executionHostId) => {
      const f = await fixture()
      vi.spyOn(f.host, 'resolveRuntimeGitTarget').mockResolvedValue({
        ...f.getTarget(),
        executionHostId
      })
      const listed = vi.spyOn(worktreeGit, 'listWorktreesStrict')
      expect(await f.documents.open(f.input, f.transport())).toEqual({
        ok: false,
        error: 'unauthorized'
      })
      expect(listed).not.toHaveBeenCalled()
    }
  )
  it.each(['ssh:other', 'runtime:other'] as const)(
    'refuses an unserved filesystem target on %s',
    async (executionHostId) => {
      const f = await fixture()
      f.setTarget({ ...f.getTarget(), executionHostId })
      const listed = vi.spyOn(worktreeGit, 'listWorktreesStrict')
      expect(await f.documents.open(f.input, f.transport())).toEqual({
        ok: false,
        error: 'unsupported_host'
      })
      expect(listed).not.toHaveBeenCalled()
    }
  )
  it('rechecks catalog authority after the Git list awaits', async () => {
    const f = await fixture()
    const gate = deferred<Awaited<ReturnType<typeof worktreeGit.listWorktreesStrict>>>()
    const listed = vi.spyOn(worktreeGit, 'listWorktreesStrict').mockReturnValue(gate.promise)
    const opened = f.documents.open(f.input, f.transport())
    await vi.waitFor(() => expect(listed).toHaveBeenCalledOnce())
    f.setRepos([])
    gate.resolve([f.getTarget().worktree.git])
    expect(await opened).toEqual({ ok: false, error: 'unauthorized' })
  })
  it('retires admitted bytes when repository ownership changes', async () => {
    const f = await fixture()
    const opened = await f.documents.open(f.input, f.transport())
    if (!opened.ok) {
      throw new Error('host document was not admitted')
    }
    f.setRepos([])
    const { filePath: _filePath, ...lease } = f.input
    expect(
      await f.documents.read(
        {
          ...lease,
          request: {
            documentHandle: opened.document.documentHandle,
            revision: opened.document.revision,
            position: 0,
            length: 4
          }
        },
        f.transport()
      )
    ).toEqual({ ok: false, error: 'unauthorized' })
    expect(await f.documents.open({ ...f.input, leaseId: randomUUID() }, f.transport())).toEqual({
      ok: false,
      error: 'unauthorized'
    })
  })
  it('requires no Git registration for an ordinary catalog-owned folder', async () => {
    const f = await fixture(false)
    const target = vi.spyOn(f.host, 'resolveRuntimeGitTarget')
    const listed = vi.spyOn(worktreeGit, 'listWorktreesStrict')
    expect((await f.documents.open(f.input, f.transport())).ok).toBe(true)
    expect(target).not.toHaveBeenCalled()
    expect(listed).not.toHaveBeenCalled()
  })
})
