import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'

import type * as NodeFs from 'node:fs'
const io = vi.hoisted(() => ({ open: 0, stat: 0, read: 0, close: 0, bytes: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      io.open++
      return actual.openSync(...args)
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      io.stat++
      return actual.fstatSync(...args)
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      io.read++
      const bytes = actual.readSync(...args)
      io.bytes += bytes
      return bytes
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      io.close++
      return actual.closeSync(...args)
    }
  }
})
import { readJsonlCursor } from './codex-rollout-jsonl-cursor'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('readJsonlFirstRecord', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects writer-less FIFOs and symlinks to them without blocking',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'codex-rollout-fifo-'))
      directories.push(directory)
      const fifo = join(directory, 'pipe.jsonl')
      const link = join(directory, 'link.jsonl')
      const created = await runProcess({ program: 'mkfifo', args: [fifo], timeoutMs: 5000 })
      expect(created.code).toBe(0)
      symlinkSync(fifo, link)
      const readerPath = resolve('src/shared/codex-rollout-jsonl-cursor.ts')
      const result = await runProcess({
        program: process.execPath,
        args: [
          '--import',
          'tsx',
          '--eval',
          `const assert = require('node:assert/strict');
const { readJsonlFirstRecord } = require(${JSON.stringify(readerPath)});
for (const path of ${JSON.stringify([fifo, link, directory])}) {
  assert.equal(readJsonlFirstRecord(path), undefined);
}`
        ],
        timeoutMs: 5000
      })
      expect(result.timedOut).toBe(false)
      expect(result.code, result.stderr).toBe(0)
    }
  )
})

it.each([1_000, 10_000])(
  'bounds real cursor IO and parsing for a %i-record corpus, append and burst',
  (count) => {
    const directory = mkdtempSync(join(tmpdir(), 'cursor-budget-'))
    directories.push(directory)
    const path = join(directory, 'rollout.jsonl')
    const row = `${JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(60) } })}\n`
    writeFileSync(path, row.repeat(count))
    const cursor = { filePath: path, offset: 0, carry: '' }
    const read = () => {
      Object.assign(io, { open: 0, stat: 0, read: 0, close: 0, bytes: 0 })
      const parse = vi.spyOn(JSON, 'parse')
      const records = readJsonlCursor(cursor)
      const parsed = parse.mock.calls.length
      parse.mockRestore()
      expect(io).toMatchObject({ open: 1, stat: 1, close: 1 })
      expect(io.read).toBeLessThanOrEqual(1)
      expect(io.bytes).toBeLessThanOrEqual(1024 * 1024)
      expect(parsed).toBeLessThanOrEqual(Math.ceil((1024 * 1024) / row.length))
      expect(Buffer.byteLength(cursor.carry)).toBeLessThanOrEqual(256 * 1024)
      return { records, parsed }
    }
    expect(read().records?.length).toBeGreaterThan(0)
    expect(read()).toEqual({ records: [], parsed: 0 })
    expect(io).toMatchObject({ read: 0, bytes: 0 })
    appendFileSync(path, row)
    expect(read().records).toHaveLength(1)
    expect(io.bytes).toBe(Buffer.byteLength(row))
    appendFileSync(path, row.repeat(count))
    expect(read().records?.length).toBeGreaterThan(0)
    expect(cursor.offset).toBe(Buffer.byteLength(row) * (count * 2 + 1))
    expect(read()).toEqual({ records: [], parsed: 0 })
  }
)
