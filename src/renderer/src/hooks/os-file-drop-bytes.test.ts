// @vitest-environment happy-dom
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { AgentSessionAttachmentStore } from '../../../main/native-chat/agent-session-attachments/agent-session-attachment-store'
import {
  createDragTempCopyLane,
  createDroppedPathPreparationQueue,
  createDroppedFileBytesIntake,
  endDroppedFileIntake
} from '../../../main/window/dropped-path-preparation'
import type { StoreDroppedFileBytesRequest } from '../../../shared/native-file-drop-preparation'
import { sharedPromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'
import { prepareOsFileDrop } from './os-file-drop-bytes'

vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
async function fixture(copyTimeoutMs = 150) {
  const root = await mkdtemp(join(tmpdir(), 'orca-chat-drop-contract-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mac')
  const sourceTempRoot = join(root, 'T')
  const dir = join(sourceTempRoot, 'TemporaryItems', 'NSIRD_test')
  await mkdir(dir, { recursive: true })
  const files = [
    new File(['x'], 'one.png'),
    new File(['y'], 'two.png'),
    new File(['z'], 'three.png')
  ]
  const paths = files.map((file) => join(dir, file.name))
  await Promise.all(paths.map((path, index) => writeFile(path, ['x', 'y', 'z'][index])))
  const store = new AgentSessionAttachmentStore(join(root, 'store'), { hasSession: () => true })
  const getStore = vi.fn(async (): Promise<AgentSessionAttachmentStore | null> => store)
  const document = new AbortController()
  const deps = {
    platform: 'darwin' as const,
    copyTimeoutMs,
    localChatAttachmentStore: getStore,
    getCopyEnvironment: async () => ({
      platform: 'darwin' as const,
      sourceTempRoot,
      copyRoot: join(root, 'drops')
    }),
    watchRenderer: () => ({ signal: document.signal, dispose: vi.fn() })
  }
  const lane = createDragTempCopyLane()
  const prepare = createDroppedPathPreparationQueue(deps, lane)
  const storeBytes = createDroppedFileBytesIntake(deps, lane)
  const api = {
    prepareDroppedPaths: vi.fn(async (request: Parameters<typeof prepare>[0]) => prepare(request)),
    storeDroppedFileBytes: vi.fn(async (request: StoreDroppedFileBytesRequest) =>
      storeBytes(request)
    ),
    endDroppedFileIntake: vi.fn(async (request: Parameters<typeof endDroppedFileIntake>[2]) =>
      endDroppedFileIntake(deps, lane, request)
    )
  }
  vi.stubGlobal('api', { fs: api })
  return { root, paths, files, store, getStore, api, storeBytes, document }
}

it('uses one deadline/store wait and one occurrence-counted aggregate across classification, reads and duplicates', async () => {
  const f = await fixture()
  const host = Promise.withResolvers<AgentSessionAttachmentStore | null>()
  f.getStore.mockReturnValue(host.promise)
  const ordinary = join(f.root, 'notes.txt')
  const changed = new File(['longer'], 'one.png')
  const result = await prepareOsFileDrop(
    [
      f.paths[0],
      ordinary,
      f.paths[1],
      join(f.paths[0], '..', 'missing.png'),
      f.paths[2],
      f.paths[1]
    ],
    [
      changed,
      new File(['notes'], 'notes.txt'),
      f.files[1],
      new File(['x'], 'missing.png'),
      f.files[2],
      f.files[1]
    ],
    'local-chat'
  )
  expect(result).toEqual({
    paths: [ordinary],
    failures: [{ target: 'rejected', reason: 'temp-copy-failed', pathCount: 5, byteLength: 0 }]
  })
  expect(f.getStore).toHaveBeenCalledTimes(1)
  expect(f.api.storeDroppedFileBytes).toHaveBeenCalledTimes(1)
  expect(sharedPromiseSettlementWaiters(host.promise).waiterCount).toBe(0)
  await prepareOsFileDrop([f.paths[0]], [f.files[0]], 'local-chat')
  expect(sharedPromiseSettlementWaiters(host.promise).waiterCount).toBe(0)
  host.resolve(f.store)
  await vi.waitFor(() => expect(f.api.endDroppedFileIntake).toHaveBeenCalledTimes(2))
  expect(await readdir(f.store.rootDir).catch(() => [])).toEqual([])
  expect(await readdir(join(f.root, 'drops')).catch(() => [])).toEqual([])
  const next = await prepareOsFileDrop(
    [f.paths[0], f.paths[1], f.paths[0]],
    [f.files[0], f.files[1], f.files[0]],
    'local-chat'
  )
  expect(next?.paths).toHaveLength(3)
  expect(next?.paths[0]).toBe(next?.paths[2])
  expect(await readFile(next!.paths[0], 'utf8')).toBe('x')
  expect(f.getStore).toHaveBeenCalledTimes(3)
})

it('aborts a held FileReader on document loss, never reads an oversize mismatch, and permits the next drop', async () => {
  const f = await fixture(1000)
  const reader = vi
    .spyOn(FileReader.prototype, 'readAsArrayBuffer')
    .mockImplementation(() => undefined)
  const abort = vi.spyOn(FileReader.prototype, 'abort')
  const pending = prepareOsFileDrop([f.paths[0]], [f.files[0]], 'local-chat')
  await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(1))
  const queued = Array.from({ length: 7 }, () =>
    prepareOsFileDrop([f.paths[0]], [f.files[0]], 'local-chat')
  )
  await expect(
    prepareOsFileDrop(
      [f.paths[0], '/notes.txt'],
      [f.files[0], new File(['n'], 'notes.txt')],
      'local-chat'
    )
  ).resolves.toMatchObject({ paths: ['/notes.txt'], failures: [{ commonReason: 'busy' }] })
  await expect(
    prepareOsFileDrop(['/ordinary.txt'], [new File(['n'], 'ordinary.txt')], 'agent')
  ).resolves.toEqual({ paths: ['/ordinary.txt'], failures: [] })
  expect(reader).toHaveBeenCalledTimes(1)
  window.dispatchEvent(new Event('pagehide'))
  f.document.abort(new Error('document gone'))
  await expect(pending).resolves.toBeUndefined()
  await Promise.all(queued)
  expect(abort).toHaveBeenCalledTimes(1)
  expect(f.getStore).not.toHaveBeenCalled()
  reader.mockRestore()
  const replacement = await fixture()
  Object.defineProperty(replacement.files[0], 'size', { value: 50 * 1024 * 1024 + 1 })
  const untouched = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer')
  const result = await prepareOsFileDrop(
    [replacement.paths[0]],
    [replacement.files[0]],
    'local-chat'
  )
  expect(result?.failures).toMatchObject([{ pathCount: 1, commonReason: 'changed' }])
  expect(untouched).not.toHaveBeenCalled()
  expect(replacement.getStore).not.toHaveBeenCalled()
  const next = await prepareOsFileDrop([replacement.paths[1]], [replacement.files[1]], 'local-chat')
  expect(next?.paths).toHaveLength(1)
})

it('keeps an expired in-transit payload leased until invoke settlement before granting another read', async () => {
  const f = await fixture(300)
  const transport = Promise.withResolvers<void>()
  const reader = vi.spyOn(FileReader.prototype, 'readAsArrayBuffer')
  f.api.storeDroppedFileBytes.mockImplementationOnce(async (request) => {
    await transport.promise
    return f.storeBytes(request)
  })
  const first = prepareOsFileDrop([f.paths[0]], [f.files[0]], 'local-chat')
  await vi.waitFor(() => expect(f.api.storeDroppedFileBytes).toHaveBeenCalledTimes(1))
  await expect(first).resolves.toMatchObject({
    paths: [],
    failures: [{ commonReason: 'timed-out' }]
  })
  expect(f.api.endDroppedFileIntake).not.toHaveBeenCalled()
  const next = prepareOsFileDrop([f.paths[1]], [f.files[1]], 'local-chat')
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(reader).toHaveBeenCalledTimes(1)
  transport.resolve()
  const result = await next
  expect(result?.paths).toHaveLength(1)
  expect(reader).toHaveBeenCalledTimes(2)
  expect(f.getStore).toHaveBeenCalledTimes(1)
  expect(await readdir(f.store.rootDir)).toHaveLength(1)
})
