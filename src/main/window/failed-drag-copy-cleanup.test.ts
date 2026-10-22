import type * as FsPromises from 'node:fs/promises'
import type * as Fs from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import {
  ABANDONED_PART_MAX_AGE_MS,
  sweepAgentSessionAttachments
} from '../native-chat/agent-session-attachments/agent-session-attachment-sweep'
import { AGENT_SESSION_ATTACHMENT_PART_FILE } from '../native-chat/agent-session-attachments/agent-session-attachment-references'
import {
  createDragTempCopyLane,
  createDroppedPathPreparationQueue,
  createDroppedFileBytesIntake,
  endDroppedFileIntake
} from './dropped-path-preparation'
import { cleanupFailedDragCopy } from './failed-drag-copy-cleanup'

const fault = vi.hoisted(() => ({ native: false, beforeWrite: (): void => undefined }))
vi.mock('electron', () => ({ app: {}, ipcMain: {} }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof FsPromises>()
  return { ...actual, writeFile: vi.fn(actual.writeFile), rm: vi.fn(actual.rm) }
})
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof Fs>()
  return {
    ...actual,
    createWriteStream: (...args: Parameters<typeof actual.createWriteStream>) => {
      const stream = actual.createWriteStream(...args)
      fault.beforeWrite()
      if (fault.native) {
        stream.once('open', () => stream.destroy(Object.assign(new Error('disk'), { code: 'EIO' })))
      }
      return stream
    }
  }
})
afterEach(() => {
  fault.native = false
  fault.beforeWrite = () => undefined
  vi.restoreAllMocks()
  vi.mocked(rm).mockReset()
  vi.mocked(writeFile).mockReset()
})

async function fixture() {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'orca-drop-cleanup-'))
  vi.mocked(rm).mockImplementation(actual.rm)
  vi.mocked(writeFile).mockImplementation(actual.writeFile)
  const sourceTempRoot = join(root, 'T')
  const source = join(sourceTempRoot, 'TemporaryItems', 'NSIRD_test', 'shot.png')
  await mkdir(dirname(source), { recursive: true })
  await actual.writeFile(source, 'image')
  const env = { platform: 'darwin' as const, sourceTempRoot, copyRoot: join(root, 'drops') }
  const store = new AgentSessionAttachmentStore(join(root, 'store'), { hasSession: () => true })
  const document = new AbortController()
  const deps = {
    platform: 'darwin' as const,
    copyTimeoutMs: 3000,
    getCopyEnvironment: async () => env,
    watchRenderer: () => ({ signal: document.signal, dispose: () => undefined }),
    localChatAttachmentStore: async () => store
  }
  const lane = createDragTempCopyLane()
  const prepare = createDroppedPathPreparationQueue(deps, lane)
  const bytes = createDroppedFileBytesIntake(deps, lane)
  const end = (intakeId: string) =>
    endDroppedFileIntake(deps, lane, { intakeId, disposition: 'complete' })
  return { actual, root, source, env, store, document, lane, prepare, bytes, end }
}

it('falls back after real store write failures without starting cleanup, then sweeps only aged incomplete uploads', async () => {
  const f = await fixture()
  const held = Promise.withResolvers<void>()
  vi.mocked(rm).mockImplementation(async (...args) => {
    await held.promise
    return f.actual.rm(...args)
  })
  vi.mocked(writeFile).mockImplementation(async (...args) => {
    await f.actual.writeFile(...args)
    if (String(args[0]).startsWith(f.store.rootDir)) {
      throw Object.assign(new Error('full'), { code: 'ENOSPC' })
    }
  })
  try {
    for (const intakeId of ['first', 'second']) {
      await f.prepare({ paths: [f.source], consumer: 'local-chat', intakeId })
      const result = await f.bytes({
        intakeId,
        sourceIndex: 0,
        name: 'shot.png',
        bytes: Buffer.from('image')
      })
      f.end(intakeId)
      expect(await readFile(result.paths[0], 'utf8')).toBe('image')
    }
    expect(rm).not.toHaveBeenCalled()
    const abandoned = await readdir(f.store.rootDir)
    expect(abandoned).toHaveLength(2)
    for (const upload of abandoned) {
      expect(await readdir(join(f.store.rootDir, upload))).toEqual([
        AGENT_SESSION_ATTACHMENT_PART_FILE
      ])
    }
    const next = await f.prepare({ paths: [f.source], consumer: 'agent' })
    expect(await readFile(next.paths[0], 'utf8')).toBe('image')
    vi.mocked(writeFile).mockImplementation(f.actual.writeFile)
    const committed = await f.store.storeFile('keep.png', Buffer.from('keep'))
    const facts = { database: () => null, recordedSessionIds: () => null }
    expect((await sweepAgentSessionAttachments(f.store, facts)).removed).toEqual([])
    held.resolve()
    const swept = await sweepAgentSessionAttachments(
      f.store,
      facts,
      Date.now() + ABANDONED_PART_MAX_AGE_MS + 1000
    )
    expect(swept.removed).toHaveLength(2)
    expect(await readFile(committed, 'utf8')).toBe('keep')
    expect(await readdir(f.env.copyRoot)).toHaveLength(3)
  } finally {
    held.resolve()
    await vi.waitFor(() => expect(f.lane.jobs.size).toBe(0))
    await f.actual.rm(f.root, { recursive: true, force: true })
  }
})

it.each(['native', 'fallback', 'fallback-abort', 'batch-abort'] as const)(
  'settles %s failure after writer/close while independent directory removal is held',
  async (route) => {
    const f = await fixture()
    const held = Promise.withResolvers<void>()
    const removals: Promise<void>[] = []
    vi.mocked(rm).mockImplementation((...args) => {
      const removal = held.promise.then(() => f.actual.rm(...args))
      removals.push(removal)
      return removal
    })
    try {
      if (route === 'native') {
        fault.native = true
        expect((await f.prepare({ paths: [f.source], consumer: 'agent' })).failures).toMatchObject([
          { commonReason: 'copy-failed' }
        ])
      } else if (route === 'fallback' || route === 'fallback-abort') {
        // A real store failure reaches the actual private-byte write, which also rejects.
        vi.mocked(writeFile).mockImplementation(async (...args) => {
          await f.actual.writeFile(...args)
          if (route === 'fallback-abort' && !String(args[0]).startsWith(f.store.rootDir)) {
            f.document.abort(new Error('document gone'))
            return
          }
          throw Object.assign(new Error('full'), { code: 'ENOSPC' })
        })
        await f.prepare({ paths: [f.source], consumer: 'local-chat', intakeId: 'fallback' })
        expect(
          (
            await f.bytes({
              intakeId: 'fallback',
              sourceIndex: 0,
              name: 'shot.png',
              bytes: Buffer.from('image')
            })
          ).failures
        ).toMatchObject([
          { commonReason: route === 'fallback-abort' ? 'timed-out' : 'out-of-space' }
        ])
        f.end('fallback')
      } else {
        const second = join(dirname(f.source), 'second.png')
        await f.actual.writeFile(second, 'other')
        let writes = 0
        fault.beforeWrite = () => {
          if (++writes === 2) {
            f.document.abort(new Error('document gone'))
          }
        }
        await expect(f.prepare({ paths: [f.source, second], consumer: 'agent' })).rejects.toThrow(
          'document gone'
        )
      }
      await vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(1))
      expect(await readdir(f.env.copyRoot)).toHaveLength(route === 'batch-abort' ? 2 : 1)
      fault.native = false
      fault.beforeWrite = () => undefined
      vi.mocked(writeFile).mockImplementation(f.actual.writeFile)
      // A replacement document shares the lane, with no cleanup permit in payload accounting.
      const next = createDroppedPathPreparationQueue(
        {
          platform: 'darwin',
          getCopyEnvironment: async () => f.env,
          watchRenderer: () => ({ signal: new AbortController().signal, dispose: () => undefined })
        },
        f.lane
      )
      const valid = await next({ paths: [f.source], consumer: 'agent' })
      expect(await readFile(valid.paths[0], 'utf8')).toBe('image')
      held.resolve()
      await vi.waitFor(async () => expect(await readdir(f.env.copyRoot)).toHaveLength(1))
      expect(await readFile(valid.paths[0], 'utf8')).toBe('image')
    } finally {
      held.resolve()
      await vi.waitFor(() => expect(removals).toHaveLength(route === 'batch-abort' ? 2 : 1))
      await Promise.all(removals)
      await vi.waitFor(() => expect(f.lane.jobs.size).toBe(0))
      await f.actual.rm(f.root, { recursive: true, force: true })
    }
  }
)

it('bounds path-only cleanup behind one held removal and abandons overflow without refusing a valid drop', async () => {
  const f = await fixture()
  const held = Promise.withResolvers<void>()
  let active = 0
  let peak = 0
  vi.mocked(rm).mockImplementation(async (...args) => {
    peak = Math.max(peak, ++active)
    await held.promise
    try {
      return await f.actual.rm(...args)
    } finally {
      active--
    }
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    const first = join(f.env.copyRoot, 'orca-drop-failed-first')
    cleanupFailedDragCopy(first)
    cleanupFailedDragCopy(first)
    for (let index = 0; index < 2048; index++) {
      const path = join(f.env.copyRoot, `orca-drop-failed-${index}`)
      cleanupFailedDragCopy(path)
      cleanupFailedDragCopy(path)
    }
    fault.native = true
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await f.prepare({ paths: [f.source], consumer: 'agent' })).failures).toHaveLength(1)
    }
    expect(warn).toHaveBeenCalledWith(
      '[drop] abandoning failed-copy cleanup: backlog full',
      expect.any(Object)
    )
    expect(rm).toHaveBeenCalledTimes(1)
    fault.native = false
    const valid = await f.prepare({ paths: [f.source], consumer: 'agent' })
    expect(await readFile(valid.paths[0], 'utf8')).toBe('image')
    held.resolve()
    await vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(2049), { timeout: 5000 })
    await vi.waitFor(() => expect(active).toBe(0))
    expect(peak).toBe(1)
    expect(await readdir(f.env.copyRoot)).toHaveLength(4)
    expect(await readFile(valid.paths[0], 'utf8')).toBe('image')
  } finally {
    held.resolve()
    await vi.waitFor(() => expect(rm).toHaveBeenCalledTimes(2049), { timeout: 5000 })
    await vi.waitFor(() => expect(active).toBe(0), { timeout: 5000 })
    await f.actual.rm(f.root, { recursive: true, force: true })
  }
})
