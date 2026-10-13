import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { runtimeViewerRpcFixture } from './runtime-plugin-viewer-rpc-test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY } from '../../shared/plugins/plugin-viewer-runtime-capability'
import type { PluginViewerRemoteOpenResponse } from '../../shared/plugins/plugin-viewer-remote-document'
import type { PluginViewerReadResponse } from '../../shared/plugins/plugin-viewer-document'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

describe('viewer document leases through real E2EE runtime RPC and catalog authorization', () => {
  it('admits one lease observer on its actual socket and denies siblings or altered owner tags', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const connection = f.connect()
    const sibling = f.connect()
    expect(await connection.request('files.pluginViewer.open', f.input, 5_000)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
    const { filePath: _filePath, ...lease } = f.input
    expect(await sibling.request('files.pluginViewer.observe', lease, 5_000)).toMatchObject({
      ok: false
    })
    expect(
      await connection.request(
        'files.pluginViewer.observe',
        { ...lease, owner: { ...lease.owner, tabId: 'foreign' } },
        5_000
      )
    ).toMatchObject({ ok: false })
    expect(await connection.request('files.pluginViewer.observe', lease, 5_000)).toMatchObject({
      ok: true,
      result: { kind: 'plugin-viewer-lifecycle', leaseId: lease.leaseId, closed: false }
    })
    expect(await connection.request('files.pluginViewer.observe', lease, 5_000)).toMatchObject({
      ok: false
    })
    expect(await connection.request('files.pluginViewer.close', lease, 5_000)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
  })
  it.each([false, true])(
    'uses actual runtime commands, binary ranges, socket ownership and close; folder workspace=%s',
    async (folderWorkspace) => {
      const f = await runtimeViewerRpcFixture(cleanups, 'runtime', folderWorkspace)
      const connection = f.connect()
      const sibling = f.connect()
      const opened = await connection.request<PluginViewerRemoteOpenResponse>(
        'files.pluginViewer.open',
        f.input,
        5_000
      )
      expect(opened.ok).toBe(true)
      if (!opened.ok || !opened.result.ok) {
        throw new Error('document open refused')
      }
      const { filePath: _filePath, ...lease } = f.input
      const read = {
        ...lease,
        request: {
          documentHandle: opened.result.document.documentHandle,
          revision: opened.result.document.revision,
          position: 1,
          length: 2
        }
      }
      expect(
        await connection.request<PluginViewerReadResponse>('files.pluginViewer.read', read, 5_000)
      ).toMatchObject({
        ok: true,
        result: {
          ok: true,
          result: {
            bytesRead: 2,
            contentBase64: Buffer.from([128, 255]).toString('base64'),
            eof: false
          }
        }
      })
      expect(await sibling.request('files.pluginViewer.read', read, 5_000)).toMatchObject({
        ok: true,
        result: { ok: false, error: 'unauthorized' }
      })
      await sibling.request('files.pluginViewer.close', lease, 5_000)
      expect(await connection.request('files.pluginViewer.read', read, 5_000)).toMatchObject({
        ok: true,
        result: { ok: true }
      })
      expect(await connection.request('files.pluginViewer.close', lease, 5_000)).toMatchObject({
        ok: true,
        result: { ok: true }
      })
      expect(await connection.request('files.pluginViewer.read', read, 5_000)).toMatchObject({
        ok: true,
        result: { ok: false, error: 'unauthorized' }
      })
    }
  )

  it('derives catalog ownership on the host and rejects foreign paths, runtime IDs and caller boundaries', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const connection = f.connect()
    const outside = join(f.root, 'private.fixture')
    await writeFile(outside, 'private')
    expect(
      await connection.request('files.pluginViewer.open', { ...f.input, filePath: outside }, 5_000)
    ).toMatchObject({ ok: true, result: { ok: false, error: 'unauthorized' } })
    expect(
      await connection.request(
        'files.pluginViewer.open',
        { ...f.input, runtimeId: 'other-runtime' },
        5_000
      )
    ).toMatchObject({ ok: true, result: { ok: false, error: 'unauthorized' } })
    expect(
      await connection.request(
        'files.pluginViewer.open',
        { ...f.input, file: { boundaryPath: f.root, entryPath: outside } },
        5_000
      )
    ).toMatchObject({ ok: false })
    expect(
      await connection.request(
        'files.pluginViewer.open',
        { ...f.input, owner: { ...f.input.owner, workspaceId: `unregistered::${f.workspace}` } },
        5_000
      )
    ).toMatchObject({ ok: true, result: { ok: false } })
    expect(await connection.request('files.pluginViewer.open', f.input, 5_000)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
  })

  it('releases actual socket-owned reservations on disconnect while the pairing is still valid', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const connection = f.connect()
    const cleanup = vi.spyOn(f.runtime, 'cleanupSubscriptionsForConnection')
    for (let i = 0; i < 8; i++) {
      expect(
        await connection.request(
          'files.pluginViewer.open',
          { ...f.input, leaseId: randomUUID() },
          5_000
        )
      ).toMatchObject({ ok: true, result: { ok: true } })
    }
    expect(await connection.request('files.pluginViewer.open', f.input, 5_000)).toMatchObject({
      ok: true,
      result: { ok: false, error: 'limit_exceeded' }
    })
    connection.close()
    await expect.poll(() => cleanup.mock.calls.length).toBeGreaterThan(0)
    const reconnected = f.connect()
    for (let i = 0; i < 8; i++) {
      expect(
        await reconnected.request(
          'files.pluginViewer.open',
          { ...f.input, leaseId: randomUUID() },
          5_000
        )
      ).toMatchObject({ ok: true, result: { ok: true } })
    }
  })

  it.each(['mobile', 'legacy'] as const)(
    'refuses %s callers without treating request metadata as capability consent',
    async (kind) => {
      const f = await runtimeViewerRpcFixture(cleanups, kind === 'mobile' ? 'mobile' : 'runtime')
      const connection = f.connect(
        kind === 'legacy' ? [] : [PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY]
      )
      expect(await connection.request('files.pluginViewer.open', f.input, 5_000)).toMatchObject({
        ok: false
      })
      expect(
        await connection.request(
          'files.pluginViewer.open',
          {
            ...f.input,
            clientCapabilities: [PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY],
            clientKind: 'runtime'
          },
          5_000
        )
      ).toMatchObject({ ok: false })
    }
  )
})
