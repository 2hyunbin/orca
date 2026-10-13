import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import {
  PluginViewerDocumentRegistry,
  type PluginViewerDocumentOwner
} from './plugin-viewer-document-registry'
import { openPluginViewerFileResource } from './plugin-viewer-file-resource'

export const viewerOwner: PluginViewerDocumentOwner = {
  executionHostId: 'native-host',
  workspaceId: 'folder-workspace',
  clientId: 'desktop-client',
  tabId: 'file-tab',
  pluginKey: 'publisher/workbook',
  pluginGeneration: 1
}

export function deferred<T>() {
  let resolve = (_value: T): void => {}
  let reject = (_error: unknown): void => {}
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export async function createViewerDocumentFixture(roots: string[], bytes: Uint8Array) {
  const root = await mkdtemp(join(tmpdir(), 'orca-viewer-document-'))
  roots.push(root)
  const workspace = join(root, 'folder')
  await mkdir(workspace)
  const entry = join(workspace, 'workbook.xlsx')
  await writeFile(entry, bytes)
  const isAuthorized = vi.fn<() => boolean>(() => true)
  const onCloseError = vi.fn<() => void>()
  const registry = new PluginViewerDocumentRegistry({ isAuthorized, onCloseError })
  const file = { boundaryPath: workspace, entryPath: entry }
  return { root, workspace, entry, file, registry, isAuthorized, onCloseError }
}

export function delayedViewerRegistry() {
  const gate = deferred<void>()
  const started = deferred<void>()
  const close = vi.fn<() => Promise<void>>(async () => {})
  const readStarted = vi.fn<() => void>()
  const registry = new PluginViewerDocumentRegistry({
    isAuthorized: () => true,
    onCloseError: vi.fn(),
    async openFile(request, signal) {
      const resource = await openPluginViewerFileResource(request, signal)
      return {
        ...resource,
        async read(position, length, readSignal) {
          readStarted()
          started.resolve()
          await gate.promise
          return resource.read(position, length, readSignal)
        },
        async close() {
          close()
          await resource.close()
        }
      }
    }
  })
  return { registry, gate, started, readStarted, close }
}
