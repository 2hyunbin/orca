import { randomUUID } from 'node:crypto'
import { rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createRuntimeViewerDocumentFixture } from './runtime-plugin-viewer-document-test-fixture'

const fixtures: Awaited<ReturnType<typeof createRuntimeViewerDocumentFixture>>[] = []
async function fixture() {
  const result = await createRuntimeViewerDocumentFixture()
  fixtures.push(result)
  return result
}
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.documents.dispose()
    await rm(fixture.root, { recursive: true, force: true })
  }
})

describe('runtime viewer transport leases on actual regular files', () => {
  it('reads binary ranges under a host-derived workspace boundary and closes its lease', async () => {
    const f = await fixture()
    const opened = await f.documents.open(f.input, f.transport())
    expect(opened.ok).toBe(true)
    if (!opened.ok) {
      throw new Error('fixture open failed')
    }
    const request = {
      documentHandle: opened.document.documentHandle,
      revision: opened.document.revision,
      position: 1,
      length: 2
    }
    expect(
      await f.documents.read({ ...f.input, filePath: undefined, request }, f.transport())
    ).toMatchObject({ ok: false, error: 'invalid_request' })
    const { filePath: _filePath, ...lease } = f.input
    expect(await f.documents.read({ ...lease, request }, f.transport())).toEqual({
      ok: true,
      result: {
        revision: opened.document.revision,
        bytesRead: 2,
        contentBase64: Buffer.from([128, 255]).toString('base64'),
        eof: false
      }
    })
    expect(f.documents.close(lease, f.transport())).toEqual({ ok: true })
    expect(await f.documents.read({ ...lease, request }, f.transport())).toEqual({
      ok: false,
      error: 'unauthorized'
    })
  })

  it.each(['connection', 'client', 'runtime', 'owner'] as const)(
    'refuses a %s mismatch without retiring the rightful lease',
    async (field) => {
      const f = await fixture()
      const opened = await f.documents.open(f.input, f.transport())
      if (!opened.ok) {
        throw new Error('fixture open failed')
      }
      const { filePath: _filePath, ...lease } = f.input
      const request = {
        documentHandle: opened.document.documentHandle,
        revision: opened.document.revision,
        position: 0,
        length: 4
      }
      const otherLease =
        field === 'runtime'
          ? { ...lease, runtimeId: 'other' }
          : field === 'owner'
            ? { ...lease, owner: { ...lease.owner, tabId: 'other' } }
            : lease
      const otherTransport =
        field === 'connection'
          ? f.transport('connection-b')
          : field === 'client'
            ? f.transport('connection-a', 'client-b')
            : f.transport()
      expect(await f.documents.read({ ...otherLease, request }, otherTransport)).toEqual({
        ok: false,
        error: 'unauthorized'
      })
      expect(f.documents.close(otherLease, otherTransport)).toEqual({ ok: true })
      expect((await f.documents.read({ ...lease, request }, f.transport())).ok).toBe(true)
    }
  )

  it('disconnects only the actual socket, including sibling sockets sharing one client identity', async () => {
    const f = await fixture()
    const a = await f.documents.open(f.input, f.transport())
    const bInput = { ...f.input, leaseId: randomUUID() }
    const b = await f.documents.open(bInput, f.transport('connection-b'))
    if (!a.ok || !b.ok) {
      throw new Error('fixture open failed')
    }
    f.subscriptions.cleanupForConnection('connection-a')
    const read = (input: typeof f.input, document: typeof a.document) => {
      const { filePath: _filePath, ...lease } = input
      return {
        ...lease,
        request: {
          documentHandle: document.documentHandle,
          revision: document.revision,
          position: 0,
          length: 4
        }
      }
    }
    expect(await f.documents.read(read(f.input, a.document), f.transport())).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect((await f.documents.read(read(bInput, b.document), f.transport('connection-b'))).ok).toBe(
      true
    )
  })

  it.each(['outside', 'traversal', 'symlink'] as const)(
    'refuses %s instead of accepting a caller-created boundary',
    async (mode) => {
      const f = await fixture()
      const outside = join(f.root, 'outside.fixture')
      await writeFile(outside, 'private')
      const escaped = join(f.workspace, 'escape.fixture')
      if (mode === 'symlink') {
        await symlink(outside, escaped, 'file')
      }
      const filePath =
        mode === 'outside'
          ? outside
          : mode === 'traversal'
            ? `${f.workspace}/../outside.fixture`
            : escaped
      expect(await f.documents.open({ ...f.input, filePath }, f.transport())).toEqual({
        ok: false,
        error: 'unauthorized'
      })
      expect(
        await f.documents.open(
          { ...f.input, file: { boundaryPath: f.root, entryPath: outside } },
          f.transport()
        )
      ).toEqual({ ok: false, error: 'invalid_request' })
    }
  )

  it.each(['replace', 'mutate', 'root', 'host', 'runtime', 'catalog'] as const)(
    'retires access when the %s changes after admission',
    async (mode) => {
      const f = await fixture()
      const opened = await f.documents.open(f.input, f.transport())
      if (!opened.ok) {
        throw new Error('fixture open failed')
      }
      const { filePath: _filePath, ...lease } = f.input
      if (mode === 'replace') {
        const replacement = join(f.workspace, 'replacement')
        await writeFile(replacement, 'changed')
        await rename(replacement, f.filePath)
      } else if (mode === 'mutate') {
        await writeFile(f.filePath, 'changed')
      } else if (mode === 'root') {
        const target = f.getTarget()
        f.setTarget({ ...target, worktree: { ...target.worktree, path: f.root } })
      } else if (mode === 'host') {
        f.getTarget().executionHostId = 'ssh:other'
      } else if (mode === 'catalog') {
        f.setRepos([])
      } else {
        f.setRuntimeId('replaced-runtime')
      }
      const result = await f.documents.read(
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
      expect(result.ok).toBe(false)
      if (result.ok) {
        throw new Error('stale resource exposed')
      }
      expect(['stale_revision', 'unauthorized']).toContain(result.error)
    }
  )

  it.each(['disconnect', 'close', 'abort'] as const)(
    'cancels a pending admission on %s and does not restore it after host resolution',
    async (mode) => {
      const f = await fixture()
      let release = () => {}
      f.setResolveGate(
        new Promise<void>((resolve) => {
          release = resolve
        })
      )
      const controller = new AbortController()
      const opening = f.documents.open(
        f.input,
        f.transport('connection-a', 'client-a', controller.signal)
      )
      if (mode === 'disconnect') {
        f.subscriptions.cleanupForConnection('connection-a')
      } else if (mode === 'abort') {
        controller.abort()
      } else {
        const { filePath: _filePath, ...lease } = f.input
        f.documents.close(lease, f.transport())
      }
      release()
      expect((await opening).ok).toBe(false)
      f.setResolveGate(Promise.resolve())
      expect((await f.documents.open(f.input, f.transport())).ok).toBe(true)
    }
  )

  it('bounds live reservations and releases capacity through real connection cleanup', async () => {
    const f = await fixture()
    for (let i = 0; i < 8; i++) {
      expect(
        (await f.documents.open({ ...f.input, leaseId: randomUUID() }, f.transport())).ok
      ).toBe(true)
    }
    expect(await f.documents.open(f.input, f.transport())).toEqual({
      ok: false,
      error: 'limit_exceeded'
    })
    f.subscriptions.cleanupForConnection('connection-a')
    expect((await f.documents.open(f.input, f.transport())).ok).toBe(true)
  })

  it('keeps canceled but unresolved admissions within the shared opening limit', async () => {
    const f = await fixture()
    let release = () => {}
    f.setResolveGate(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const first = f.documents.open(f.input, f.transport())
    const second = f.documents.open({ ...f.input, leaseId: randomUUID() }, f.transport())
    f.subscriptions.cleanupForConnection('connection-a')
    expect(await f.documents.open({ ...f.input, leaseId: randomUUID() }, f.transport())).toEqual({
      ok: false,
      error: 'limit_exceeded'
    })
    release()
    expect((await first).ok).toBe(false)
    expect((await second).ok).toBe(false)
    expect((await f.documents.open(f.input, f.transport())).ok).toBe(true)
  })

  it('rechecks runtime identity after awaiting workspace ownership during a read', async () => {
    const f = await fixture()
    const opened = await f.documents.open(f.input, f.transport())
    if (!opened.ok) {
      throw new Error('fixture open failed')
    }
    let release = () => {}
    f.setResolveGate(
      new Promise<void>((resolve) => {
        release = resolve
      })
    )
    const { filePath: _filePath, ...lease } = f.input
    const reading = f.documents.read(
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
    f.setRuntimeId('replaced-runtime')
    release()
    expect(await reading).toEqual({ ok: false, error: 'unauthorized' })
  })
})
