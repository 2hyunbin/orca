import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runtimeViewerRpcFixture } from './runtime-plugin-viewer-rpc-test-fixture'
import {
  PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY,
  PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY
} from '../../shared/plugins/plugin-viewer-runtime-capability'
import type { PluginViewerRuntimeSelectionResponse } from '../../shared/plugins/plugin-viewer-runtime-document'
import type { PluginViewerRemoteOpenResponse } from '../../shared/plugins/plugin-viewer-remote-document'
import { ALL_RPC_METHODS } from './rpc/methods'
import { denyRpcMethodForCaller } from './rpc/rpc-caller-scope'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})
const capabilities = [
  PLUGIN_VIEWER_RUNTIME_DOCUMENT_CAPABILITY,
  PLUGIN_VIEWER_RUNTIME_SELECTION_CAPABILITY
]

describe('named viewer file selection through real authenticated runtime RPC', () => {
  it('requires host administration, allows paired clients and denies mobile callers', () => {
    const method = ALL_RPC_METHODS.find((method) => method.name === 'files.pluginViewer.select')
    expect(method?.permission).toBe('host-admin')
    expect(
      denyRpcMethodForCaller({ kind: 'mobile' }, 'files.pluginViewer.select', method?.permission)
    ).toContain('not available')
    expect(
      denyRpcMethodForCaller(
        { kind: 'runtime-paired', grants: [] },
        'files.pluginViewer.select',
        method?.permission
      )
    ).toBeNull()
  })
  it.each([false, true])(
    'opens only the selected outside file on its actual encrypted socket; folder=%s',
    async (folder) => {
      const f = await runtimeViewerRpcFixture(cleanups, 'runtime', folder)
      const filePath = join(f.root, 'named.fixture')
      await writeFile(filePath, Buffer.from([128, 255, 0, 42]))
      const input = { ...f.input, filePath }
      const connection = f.connect(capabilities)
      const sibling = f.connect(capabilities)
      expect(await connection.request('files.pluginViewer.open', input, 5_000)).toMatchObject({
        ok: true,
        result: { ok: false, error: 'unauthorized' }
      })
      const selected = await connection.request<PluginViewerRuntimeSelectionResponse>(
        'files.pluginViewer.select',
        input,
        5_000
      )
      if (!selected.ok || !selected.result.ok) {
        throw new Error('selection refused')
      }
      const opening = { ...input, selectionGrantId: selected.result.grantId }
      expect(await sibling.request('files.pluginViewer.open', opening, 5_000)).toMatchObject({
        ok: true,
        result: { ok: false, error: 'unauthorized' }
      })
      expect(
        await connection.request(
          'files.pluginViewer.open',
          { ...opening, filePath: f.filePath },
          5_000
        )
      ).toMatchObject({ ok: true, result: { ok: false, error: 'unauthorized' } })
      const opened = await connection.request<PluginViewerRemoteOpenResponse>(
        'files.pluginViewer.open',
        opening,
        5_000
      )
      if (!opened.ok || !opened.result.ok) {
        throw new Error('selected open refused')
      }
      const lease = { owner: input.owner, runtimeId: input.runtimeId, leaseId: input.leaseId }
      const read = {
        ...lease,
        request: {
          documentHandle: opened.result.document.documentHandle,
          revision: opened.result.document.revision,
          position: 0,
          length: 4
        }
      }
      expect(await connection.request('files.pluginViewer.read', read, 5_000)).toMatchObject({
        ok: true,
        result: {
          ok: true,
          result: { contentBase64: Buffer.from([128, 255, 0, 42]).toString('base64') }
        }
      })
      expect(await connection.request('files.pluginViewer.observe', lease, 5_000)).toMatchObject({
        ok: true,
        result: { closed: false }
      })
      await connection.request('files.pluginViewer.close', lease, 5_000)
      expect(await connection.request('files.pluginViewer.open', opening, 5_000)).toMatchObject({
        ok: true,
        result: { ok: false, error: 'unauthorized' }
      })
    }
  )

  it('requires runtime scope and negotiated selection capability before any file is selected', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const select = vi.spyOn(f.runtime, 'selectRuntimePluginViewerFile')
    expect(await f.connect().request('files.pluginViewer.select', f.input, 5_000)).toMatchObject({
      ok: false
    })
    expect(select).not.toHaveBeenCalled()
    const mobile = await runtimeViewerRpcFixture(cleanups, 'mobile')
    const mobileSelect = vi.spyOn(mobile.runtime, 'selectRuntimePluginViewerFile')
    expect(
      await mobile.connect(capabilities).request('files.pluginViewer.select', mobile.input, 5_000)
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(mobileSelect).not.toHaveBeenCalled()
    expect(await f.connect().request('files.pluginViewer.open', f.input, 5_000)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
  })

  it('expires unconsumed grants on actual socket loss without invalidating the paired credential', async () => {
    const f = await runtimeViewerRpcFixture(cleanups)
    const connection = f.connect(capabilities)
    const selected = await connection.request<PluginViewerRuntimeSelectionResponse>(
      'files.pluginViewer.select',
      f.input,
      5_000
    )
    if (!selected.ok || !selected.result.ok) {
      throw new Error('selection refused')
    }
    const grantId = selected.result.grantId
    const cleanup = vi.spyOn(f.runtime, 'cleanupSubscriptionsForConnection')
    connection.close()
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalled())
    const replacement = f.connect(capabilities)
    expect(
      await replacement.request(
        'files.pluginViewer.open',
        { ...f.input, selectionGrantId: grantId },
        5_000
      )
    ).toMatchObject({ ok: true, result: { ok: false, error: 'unauthorized' } })
    expect(await replacement.request('files.pluginViewer.select', f.input, 5_000)).toMatchObject({
      ok: true,
      result: { ok: true }
    })
  })
})
