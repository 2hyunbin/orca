import { randomUUID } from 'node:crypto'
import { rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeViewerDocumentFixture } from './runtime-plugin-viewer-document-test-fixture'
import { RUNTIME_VIEWER_SELECTION_TTL_MS } from './runtime-plugin-viewer-selections'
import type { PluginViewerRuntimeOpen } from '../../shared/plugins/plugin-viewer-runtime-document'

const fixtures: Awaited<ReturnType<typeof createRuntimeViewerDocumentFixture>>[] = []
async function fixture() {
  const f = await createRuntimeViewerDocumentFixture()
  fixtures.push(f)
  const filePath = join(f.root, 'selected.fixture')
  await writeFile(filePath, Buffer.from([42, 255, 128, 0]))
  return { ...f, input: { ...f.input, filePath } }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of fixtures.splice(0)) {
    await f.documents.dispose()
    await rm(f.root, { recursive: true, force: true })
  }
})

async function grant(f: Awaited<ReturnType<typeof fixture>>) {
  const selected = await f.documents.select(f.input, f.transport())
  expect(selected.ok).toBe(true)
  if (!selected.ok) {
    throw new Error('selection failed')
  }
  return { ...f.input, selectionGrantId: selected.grantId }
}

describe('host-issued runtime viewer file selections on actual regular files', () => {
  it('requires a grant for the exact outside file and transfers its selected handle once', async () => {
    const f = await fixture()
    expect(await f.documents.open(f.input, f.transport())).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect(
      await f.documents.open({ ...f.input, access: { kind: 'user-file' } }, f.transport())
    ).toEqual({ ok: false, error: 'invalid_request' })
    const input = await grant(f)
    const opened = await f.documents.open(input, f.transport())
    if (!opened.ok) {
      throw new Error('grant open failed')
    }
    const lease = { owner: input.owner, runtimeId: input.runtimeId, leaseId: input.leaseId }
    expect(
      await f.documents.read(
        {
          ...lease,
          request: {
            documentHandle: opened.document.documentHandle,
            revision: opened.document.revision,
            position: 1,
            length: 2
          }
        },
        f.transport()
      )
    ).toMatchObject({
      ok: true,
      result: { contentBase64: Buffer.from([255, 128]).toString('base64') }
    })
    f.documents.close(lease, f.transport())
    expect(await f.documents.open(input, f.transport())).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect(
      await f.documents.open({ ...input, selectionGrantId: randomUUID() }, f.transport())
    ).toEqual({ ok: false, error: 'unauthorized' })
  })

  it.each([
    'socket',
    'credential',
    'runtime',
    'lease',
    'workspace',
    'tab',
    'plugin',
    'generation',
    'path'
  ] as const)('denies a changed %s without consuming the rightful selection', async (field) => {
    const f = await fixture()
    const input = await grant(f)
    const changed = {
      ...input,
      ...(field === 'runtime' ? { runtimeId: 'foreign' } : {}),
      ...(field === 'lease' ? { leaseId: randomUUID() } : {}),
      ...(field === 'path' ? { filePath: f.filePath } : {}),
      owner: {
        ...input.owner,
        ...(field === 'workspace' ? { workspaceId: `foreign::${f.workspace}` } : {}),
        ...(field === 'tab' ? { tabId: 'other' } : {}),
        ...(field === 'plugin' ? { pluginKey: 'other.viewer' } : {}),
        ...(field === 'generation' ? { pluginGeneration: 2 } : {})
      }
    }
    const transport =
      field === 'socket'
        ? f.transport('other-socket')
        : field === 'credential'
          ? f.transport('connection-a', 'other-credential')
          : f.transport()
    expect(await f.documents.open(changed, transport)).toEqual({ ok: false, error: 'unauthorized' })
    expect((await f.documents.open(input, f.transport())).ok).toBe(true)
  })

  it.each(['replace', 'mutate', 'symlink', 'catalog', 'runtime'] as const)(
    'invalidates the selected snapshot when %s changes before admission',
    async (change) => {
      const f = await fixture()
      if (change === 'symlink') {
        const source = join(f.root, 'source.fixture')
        await writeFile(source, 'first')
        await rm(f.input.filePath)
        await symlink(source, f.input.filePath, 'file')
      }
      const input = await grant(f)
      if (change === 'replace') {
        const replacement = join(f.root, 'replacement.fixture')
        await writeFile(replacement, 'replacement')
        await rename(replacement, input.filePath)
      } else if (change === 'mutate') {
        await writeFile(input.filePath, 'changed')
      } else if (change === 'symlink') {
        await rm(input.filePath)
        const other = join(f.root, 'other.fixture')
        await writeFile(other, 'second')
        await symlink(other, input.filePath, 'file')
      } else if (change === 'catalog') {
        f.setRepos([])
      } else {
        f.setRuntimeId('replacement-runtime')
      }
      expect(await f.documents.open(input, f.transport())).toMatchObject({
        ok: false,
        error: ['catalog', 'runtime'].includes(change) ? 'unauthorized' : 'stale_revision'
      })
    }
  )

  it('checks expiration at consumption and actual socket cleanup', async () => {
    const f = await fixture()
    const expired = await grant(f)
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + RUNTIME_VIEWER_SELECTION_TTL_MS + 1)
    expect(await f.documents.open(expired, f.transport())).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    clock.mockRestore()
    const disconnected = await grant(f)
    f.subscriptions.cleanupForConnection('connection-a')
    expect(await f.documents.open(disconnected, f.transport())).toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect((await f.documents.select(f.input, f.transport('replacement-socket'))).ok).toBe(true)
  })

  it('shares its eight-file capacity with live documents and transfers a reserved slot', async () => {
    const f = await fixture()
    const selections: PluginViewerRuntimeOpen[] = []
    for (let index = 0; index < 4; index++) {
      const input = { ...f.input, leaseId: randomUUID() }
      const selected = await f.documents.select(input, f.transport())
      if (!selected.ok) {
        throw new Error('selection failed')
      }
      selections.push({ ...input, selectionGrantId: selected.grantId })
    }
    for (let index = 0; index < 4; index++) {
      expect(
        (
          await f.documents.open(
            { ...f.input, filePath: f.filePath, leaseId: randomUUID() },
            f.transport()
          )
        ).ok
      ).toBe(true)
    }
    expect(await f.documents.select({ ...f.input, leaseId: randomUUID() }, f.transport())).toEqual({
      ok: false,
      error: 'limit_exceeded'
    })
    expect(
      await f.documents.open(
        { ...f.input, filePath: f.filePath, leaseId: randomUUID() },
        f.transport()
      )
    ).toEqual({ ok: false, error: 'limit_exceeded' })
    expect((await f.documents.open(selections[0], f.transport())).ok).toBe(true)
    f.subscriptions.cleanupForConnection('connection-a')
    expect((await f.documents.select(f.input, f.transport('new-socket'))).ok).toBe(true)
  })

  it('counts cancelled unresolved selections against the shared opening budget until settlement', async () => {
    const f = await fixture()
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    f.setResolveGate(gate)
    const controller = new AbortController()
    const first = f.documents.select(f.input, f.transport('first', 'client-a', controller.signal))
    controller.abort()
    const second = f.documents.select(f.input, f.transport('second'))
    expect(await f.documents.select(f.input, f.transport('third'))).toEqual({
      ok: false,
      error: 'limit_exceeded'
    })
    expect(
      await f.documents.open({ ...f.input, filePath: f.filePath }, f.transport('third'))
    ).toEqual({ ok: false, error: 'limit_exceeded' })
    release()
    expect(await first).toEqual({ ok: false, error: 'cancelled' })
    expect((await second).ok).toBe(true)
    expect((await f.documents.select(f.input, f.transport('third'))).ok).toBe(true)
  })

  it('refuses directories, unregistered owners and all selections after disposal', async () => {
    const f = await fixture()
    expect(await f.documents.select({ ...f.input, filePath: f.root }, f.transport())).toMatchObject(
      { ok: false }
    )
    expect(
      await f.documents.select(
        { ...f.input, owner: { ...f.input.owner, workspaceId: `unknown::${f.workspace}` } },
        f.transport()
      )
    ).toMatchObject({ ok: false })
    await f.documents.dispose()
    expect(await f.documents.select(f.input, f.transport())).toEqual({
      ok: false,
      error: 'unavailable'
    })
    expect(await f.documents.open(f.input, f.transport())).toEqual({
      ok: false,
      error: 'unavailable'
    })
  })
})
