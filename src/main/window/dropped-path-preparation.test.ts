import type * as NodeFsPromises from 'node:fs/promises'
import { rename, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { DragTempCopyItemResult } from './dragged-temp-file-copy'
import type * as DragTempFileCopy from './dragged-temp-file-copy'
import {
  createDragTempCopyLane,
  createDroppedFileBytesIntake,
  endDroppedFileIntake,
  createDroppedPathPreparationQueue,
  MAX_PENDING_DRAG_TEMP_COPIES
} from './dropped-path-preparation'

const materialize = vi.hoisted(() => vi.fn())
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof NodeFsPromises>()
  return { ...actual, rename: vi.fn(actual.rename) }
})
vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
vi.mock('./dragged-temp-file-copy', async (original) => ({
  ...(await original<typeof DragTempFileCopy>()),
  materializeDragTempPaths: materialize
}))
const TEMP = join('/', 'var', 'T', 'TemporaryItems', 'NSIRD_one', 'Shot.png')
const ORDINARY = join('/', 'files', 'notes.txt')
const COPY = join('/', 'var', 'T', 'orca-drops', 'orca-drop-abc123', 'Shot.png')
const env = { platform: 'darwin' as const, sourceTempRoot: '/var/T', copyRoot: '/var/T/drops' }

function queue(lane = createDragTempCopyLane(), copyTimeoutMs = 1000) {
  const controller = new AbortController()
  const dispose = vi.fn()
  const enqueue = createDroppedPathPreparationQueue(
    {
      platform: 'darwin',
      getCopyEnvironment: async () => env,
      watchRenderer: () => ({ signal: controller.signal, dispose }),
      copyTimeoutMs
    },
    lane
  )
  return {
    enqueue: async (request: Parameters<typeof enqueue>[0]) => enqueue(request),
    controller,
    dispose
  }
}
function deferred<T = DragTempCopyItemResult[]>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
beforeEach(() => {
  materialize.mockReset()
  vi.mocked(rename).mockReset()
})

async function realDrop() {
  const root = await mkdtemp(join(tmpdir(), 'orca-30419-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const sourceTempRoot = join(root, 'T')
  const source = join(sourceTempRoot, 'TemporaryItems', 'NSIRD_test', 'shot.png')
  await mkdir(join(source, '..'), { recursive: true })
  await writeFile(source, 'image')
  const actual = await vi.importActual<typeof DragTempFileCopy>('./dragged-temp-file-copy')
  materialize.mockImplementation(actual.materializeDragTempPaths)
  return {
    source,
    env: { platform: 'darwin' as const, sourceTempRoot, copyRoot: join(root, 'drops') },
    store: new AgentSessionAttachmentStore(join(root, 'store'), { hasSession: () => false })
  }
}

function localIntake(
  environment: DragTempFileCopy.DragTempCopyEnvironment,
  getStore: () => Promise<AgentSessionAttachmentStore | null>,
  copyTimeoutMs = 3000
) {
  const deps = {
    platform: 'darwin' as const,
    getCopyEnvironment: async () => environment,
    watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() }),
    localChatAttachmentStore: getStore,
    copyTimeoutMs
  }
  const lane = createDragTempCopyLane()
  return {
    prepare: createDroppedPathPreparationQueue(deps, lane),
    storeBytes: createDroppedFileBytesIntake(deps, lane),
    end: (intakeId: string) =>
      endDroppedFileIntake(deps, lane, { intakeId, disposition: 'complete' }),
    lane,
    deps
  }
}

const listed = (dir: string) => readdir(dir).catch(() => [])

describe('dropped path preparation through the shared copy queue', () => {
  it('grants checked small files in occurrence order, keeping the large-file path route', async () => {
    const { source, env } = await realDrop()
    const large = join(dirname(source), 'large.png')
    const bytes = Buffer.alloc(AGENT_SESSION_ATTACHMENT_MAX_BYTES + 1, 7)
    await writeFile(large, bytes)
    const getStore = vi.fn(async () => null)
    const intake = localIntake(env, getStore)
    const intakeId = randomUUID()
    const result = await intake.prepare({
      paths: [ORDINARY, source, large, source],
      consumer: 'local-chat',
      intakeId
    })
    expect(result.fromDroppedFiles).toEqual([
      { sourceIndex: 1, byteLength: 5, position: 1 },
      { sourceIndex: 1, byteLength: 5, position: 3 }
    ])
    expect(result.intake).toMatchObject({ intakeId })
    expect(result.paths[0]).toBe(ORDINARY)
    expect((await readFile(result.paths[1])).equals(bytes)).toBe(true)
    expect(getStore).not.toHaveBeenCalled()
    intake.end(intakeId)
  })

  it.each(['direct', 'unavailable', 'refused', 'write fails'] as const)(
    'writes received bytes to the store or one private fallback: %s',
    async (mode) => {
      const { source, env, store } = await realDrop()
      if (mode === 'write fails') {
        vi.spyOn(store, 'storeFile').mockRejectedValueOnce(new Error('ENOSPC'))
      }
      const getStore = vi.fn(async () => {
        if (mode === 'refused') {
          throw new Error('host refused')
        }
        return mode === 'unavailable' ? null : store
      })
      const intake = localIntake(env, getStore)
      const intakeId = randomUUID()
      await intake.prepare({ paths: [source], consumer: 'local-chat', intakeId })
      const result = await intake.storeBytes({
        intakeId,
        sourceIndex: 0,
        name: 'Shot.png',
        bytes: Buffer.from('image')
      })
      intake.end(intakeId)
      expect(result.failures).toEqual([])
      expect(await readFile(result.paths[0], 'utf8')).toBe('image')
      expect(dirname(dirname(result.paths[0]))).toBe(
        mode === 'direct' ? store.rootDir : env.copyRoot
      )
      expect(await listed(env.copyRoot)).toHaveLength(mode === 'direct' ? 0 : 1)
      if (mode !== 'direct' && process.platform !== 'win32') {
        expect((await stat(result.paths[0])).mode & 0o777).toBe(0o600)
      }
      expect(getStore).toHaveBeenCalledTimes(1)
    }
  )

  it('detaches one stalled host wait at the whole-drop deadline without late fallback', async () => {
    const { source, env, store } = await realDrop()
    const host = deferred<AgentSessionAttachmentStore | null>()
    const getStore = vi.fn().mockReturnValueOnce(host.promise).mockResolvedValue(store)
    const intake = localIntake(env, getStore, 100)
    const intakeId = randomUUID()
    await intake.prepare({ paths: [source, source], consumer: 'local-chat', intakeId })
    const bytes = { intakeId, sourceIndex: 0, name: 'Shot.png', bytes: Buffer.from('image') }
    const pending = intake.storeBytes(bytes)
    await vi.waitFor(() => expect(getStore).toHaveBeenCalledTimes(1))
    await expect(pending).resolves.toMatchObject({
      paths: [],
      failures: [{ commonReason: 'timed-out' }]
    })
    expect(() => intake.storeBytes(bytes)).toThrow('Invalid')
    intake.end(intakeId)
    host.resolve(store)
    await settle()
    expect(await listed(env.copyRoot)).toEqual([])
    expect(await listed(store.rootDir)).toEqual([])
    const next = randomUUID()
    await intake.prepare({ paths: [source], consumer: 'local-chat', intakeId: next })
    expect((await intake.storeBytes({ ...bytes, intakeId: next })).paths).toHaveLength(1)
    intake.end(next)
  })

  it('refuses a continuation past the fixed expiry even before the timer callback runs', async () => {
    const { source, env } = await realDrop()
    const getStore = vi.fn(async () => null)
    const intake = localIntake(env, getStore, 1000)
    const intakeId = randomUUID()
    const result = await intake.prepare({ paths: [source], consumer: 'local-chat', intakeId })
    expect(result.intake).toBeDefined()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(result.intake!.expiresAt + 1)
    onTestFinished(() => clock.mockRestore())
    expect(() =>
      intake.storeBytes({ intakeId, sourceIndex: 0, name: 'Shot.png', bytes: Buffer.from('image') })
    ).toThrow('timed-out')
    expect(getStore).not.toHaveBeenCalled()
    intake.end(intakeId)
  })

  it('retains admission through reads and physically drains an expired committed write before another grant', async () => {
    const { source, env, store } = await realDrop()
    const intake = localIntake(env, async () => store, 300)
    const intakeId = randomUUID()
    await intake.prepare({ paths: [source], consumer: 'local-chat', intakeId })
    expect(() => intake.prepare({ paths: [source], consumer: 'local-chat', intakeId })).toThrow(
      'already registered'
    )
    const bytes = { intakeId, sourceIndex: 0, name: 'Shot.png', bytes: Buffer.from('image') }
    expect(() => createDroppedFileBytesIntake({ ...intake.deps }, intake.lane)(bytes)).toThrow(
      'Invalid'
    )
    const waiting = Array.from({ length: 7 }, (_, index) =>
      intake.prepare({ paths: [source], consumer: 'agent', intakeId: `queued-${index}` })
    )
    await expect(
      Promise.resolve(intake.prepare({ paths: [ORDINARY, source], consumer: 'agent' }))
    ).resolves.toMatchObject({ paths: [ORDINARY], failures: [{ commonReason: 'busy' }] })
    await expect(
      Promise.resolve(intake.prepare({ paths: [ORDINARY], consumer: 'agent' }))
    ).resolves.toEqual({ paths: [ORDINARY], failures: [] })
    const release = deferred<void>()
    onTestFinished(() => release.resolve())
    const issued = deferred<string>()
    const actual = await vi.importActual<typeof NodeFsPromises>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      issued.resolve(String(to))
      await release.promise
      return actual.rename(from, to)
    })
    const pending = intake.storeBytes(bytes)
    const path = await issued.promise
    await expect(pending).resolves.toMatchObject({
      paths: [],
      failures: [{ commonReason: 'timed-out' }]
    })
    intake.end(intakeId)
    await settle()
    intake.end('queued-0')
    waiting.push(intake.prepare({ paths: [source], consumer: 'agent', intakeId: 'replacement' }))
    expect(materialize).toHaveBeenCalledTimes(1)
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await listed(env.copyRoot)).toEqual([])
    release.resolve()
    await Promise.all(waiting)
    expect(await readFile(path, 'utf8')).toBe('image')
    expect(await listed(env.copyRoot)).toHaveLength(7)
    expect(materialize).toHaveBeenCalledTimes(8)
    expect(() => intake.storeBytes(bytes)).toThrow('Invalid')
  })

  it.each(['agent', 'main-reader'] as const)(
    'passes ordinary paths without copying for %s',
    async (consumer) => {
      const { enqueue } = queue()
      await expect(enqueue({ paths: [ORDINARY], consumer })).resolves.toEqual({
        paths: [ORDINARY],
        failures: []
      })
      expect(materialize).not.toHaveBeenCalled()
    }
  )

  it.each(['agent', 'main-reader'] as const)(
    'withholds uncopied originals only from agents: %s',
    async (consumer) => {
      materialize.mockResolvedValue([
        { sourcePath: ORDINARY, status: 'imported', destPath: ORDINARY },
        { sourcePath: TEMP, status: 'uncopied', reason: 'storage-full' }
      ])
      const { enqueue } = queue()
      const result = await enqueue({ paths: [ORDINARY, TEMP], consumer })
      expect(result.paths).toEqual(consumer === 'agent' ? [ORDINARY] : [ORDINARY, TEMP])
      expect(result.failures).toEqual(
        consumer === 'agent'
          ? [
              {
                byteLength: 0,
                pathCount: 1,
                reason: 'temp-copy-failed',
                target: 'rejected',
                commonReason: 'storage-full'
              }
            ]
          : []
      )
    }
  )

  it('preserves ordinary successes and copied successes when another file fails', async () => {
    materialize.mockResolvedValue([
      { sourcePath: ORDINARY, status: 'imported', destPath: ORDINARY },
      { sourcePath: TEMP, status: 'imported', destPath: COPY },
      { sourcePath: TEMP, status: 'failed', reason: 'missing' }
    ])
    const result = await queue().enqueue({
      paths: [ORDINARY, TEMP, TEMP],
      consumer: 'agent'
    })
    expect(result.paths).toEqual([ORDINARY, COPY])
    expect(result.failures[0]).toMatchObject({ pathCount: 1, commonReason: 'missing' })
  })

  it('serializes copy requests from different owners', async () => {
    const first = deferred()
    materialize
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    const { enqueue } = queue()
    const chat = enqueue({ paths: [TEMP], consumer: 'agent' })
    const editor = enqueue({ paths: [TEMP], consumer: 'main-reader' })
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
    first.resolve([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await expect(chat).resolves.toEqual({ paths: [COPY], failures: [] })
    await expect(editor).resolves.toEqual({ paths: [COPY], failures: [] })
    expect(materialize).toHaveBeenCalledTimes(2)
  })

  it('shares serialization and the pending cap across replacement-window queues', async () => {
    materialize.mockReturnValue(new Promise(() => undefined))
    const lane = createDragTempCopyLane()
    const first = queue(lane)
    const second = queue(lane)
    const results = Array.from({ length: MAX_PENDING_DRAG_TEMP_COPIES }, () =>
      first.enqueue({ paths: [TEMP], consumer: 'agent' }).catch(() => undefined)
    )
    await expect(
      second.enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })
    ).resolves.toMatchObject({ paths: [ORDINARY], failures: [{ commonReason: 'busy' }] })
    first.controller.abort(new Error('test ended'))
    await Promise.all(results)
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
  })

  it('lets another owner prepare ordinary paths while a copy waits', async () => {
    const copy = deferred()
    materialize.mockReturnValueOnce(copy.promise)
    const { enqueue } = queue()
    const pending = enqueue({ paths: [TEMP], consumer: 'agent' })
    await expect(enqueue({ paths: [ORDINARY], consumer: 'main-reader' })).resolves.toEqual({
      paths: [ORDINARY],
      failures: []
    })
    copy.resolve([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await pending
  })

  it('aborts running and queued requests on reload and releases their listeners', async () => {
    const raw = deferred()
    materialize.mockReturnValue(raw.promise)
    const { enqueue, controller, dispose } = queue()
    const running = enqueue({ paths: [TEMP], consumer: 'agent' })
    const queued = enqueue({ paths: [TEMP], consumer: 'agent' })
    const assertions = [
      expect(running).rejects.toThrow('reloaded'),
      expect(queued).rejects.toThrow('reloaded')
    ]
    await settle()
    controller.abort(new Error('reloaded'))
    await Promise.all(assertions)
    await settle()
    expect(materialize).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    raw.resolve([])
    await settle()
    expect(dispose).toHaveBeenCalledTimes(2)
  })

  it('keeps raw native copies counted after logical timeout, then advances after drain', async () => {
    const raw = deferred()
    materialize
      .mockReturnValueOnce(raw.promise)
      .mockResolvedValueOnce([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    const { enqueue } = queue(undefined, 100)
    const first = enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })
    const next = enqueue({ paths: [TEMP], consumer: 'agent' })
    await expect(first).resolves.toMatchObject({
      paths: [ORDINARY],
      failures: [{ commonReason: 'timed-out' }]
    })
    expect(materialize).toHaveBeenCalledTimes(1)
    raw.resolve([])
    await expect(next).resolves.toEqual({ paths: [COPY], failures: [] })
  })
  it('passes drag-temp-looking paths unchanged on Linux and Windows', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const enqueue = createDroppedPathPreparationQueue({
        platform,
        getCopyEnvironment: async () => env,
        watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() })
      })
      expect(enqueue({ paths: [TEMP], consumer: 'agent' })).toEqual({ paths: [TEMP], failures: [] })
    }
    expect(materialize).not.toHaveBeenCalled()
  })

  it('reports all lost paths without a shared reason when their failures differ', async () => {
    materialize.mockResolvedValue([
      { sourcePath: TEMP, status: 'failed', reason: 'missing' },
      { sourcePath: TEMP, status: 'failed', reason: 'changed' }
    ])
    await expect(queue().enqueue({ paths: [TEMP, TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [],
      failures: [{ byteLength: 0, pathCount: 2, reason: 'temp-copy-failed', target: 'rejected' }]
    })
  })

  it('keeps ordinary paths and serves the next drop when the copy environment fails', async () => {
    const getCopyEnvironment = vi.fn(async () => env)
    getCopyEnvironment.mockRejectedValueOnce(new Error('no temp path'))
    const enqueue = createDroppedPathPreparationQueue({
      platform: 'darwin',
      getCopyEnvironment,
      watchRenderer: () => ({ signal: new AbortController().signal, dispose: vi.fn() })
    })
    await expect(enqueue({ paths: [ORDINARY, TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [ORDINARY],
      failures: [
        {
          byteLength: 0,
          pathCount: 1,
          reason: 'temp-copy-failed',
          target: 'rejected',
          commonReason: 'copy-failed'
        }
      ]
    })
    materialize.mockResolvedValue([{ sourcePath: TEMP, status: 'imported', destPath: COPY }])
    await expect(enqueue({ paths: [TEMP], consumer: 'agent' })).resolves.toEqual({
      paths: [COPY],
      failures: []
    })
  })
})
