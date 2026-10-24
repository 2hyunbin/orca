import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runProcess } from '@orca/process-host'

import type * as NodeFs from 'node:fs'
const io = vi.hoisted(() => ({
  open: 0,
  stat: 0,
  read: 0,
  close: 0,
  bytes: 0,
  short: false,
  fault: '',
  birth: 0
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      io.open++
      if (io.fault === 'open') {
        io.fault = ''
        throw new Error('injected open failure')
      }
      return actual.openSync(...args)
    },
    fstatSync: (...args: Parameters<typeof actual.fstatSync>) => {
      io.stat++
      const stats = actual.fstatSync(...args)
      return io.birth ? Object.assign(stats, { birthtimeMs: io.birth }) : stats
    },
    readSync: (...args: Parameters<typeof actual.readSync>) => {
      io.read++
      if (io.fault === 'read') {
        io.fault = ''
        throw new Error('injected read failure')
      }
      const bytes = actual.readSync(...args)
      io.bytes += bytes
      if (io.short) {
        io.short = false
        return Math.max(0, bytes - 1)
      }
      return bytes
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      io.close++
      return actual.closeSync(...args)
    }
  }
})
import { readJsonlCursor } from './codex-rollout-jsonl-cursor'
import {
  readClaudePermissionObservation,
  type ClaudePermissionObservation
} from './agent-hook-listener/providers/claude-permission-transcript-records'

const directories: string[] = []

afterEach(() => {
  Object.assign(io, { fault: '', birth: 0, short: false })
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
    writeFileSync(path, '{"id":"A"}\n{"id":')
    const appendCursor = { filePath: path, offset: 0, carry: '' }
    const gap = vi.fn()
    io.birth = 100
    expect(readJsonlCursor(appendCursor, undefined, gap)).toEqual([{ id: 'A' }])
    appendFileSync(path, '"B"}\n')
    io.birth = 101
    io.bytes = 0
    expect(readJsonlCursor(appendCursor, undefined, gap)).toEqual([{ id: 'B' }])
    expect(io.bytes).toBe(5)
    expect(gap).not.toHaveBeenCalled()
  }
)

it('qualifies bounded acquisition, fragments and gaps without reviving lost proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'cursor-short-'))
  directories.push(directory)
  const filePath = join(directory, 'session.jsonl')
  writeFileSync(filePath, '{"ok":true}\n')
  const ordinary = { filePath, offset: 0, carry: '' }
  io.short = true
  expect(readJsonlCursor(ordinary)).toEqual([])
  expect(ordinary.offset).toBe(11)
  expect(ordinary.carry).toBe('{"ok":true}')
  expect(readJsonlCursor(ordinary)).toEqual([{ ok: true }])
  const lines = readFileSync(join(__dirname, '__fixtures__/claude-permission-escape.jsonl'), 'utf8')
    .trim()
    .split('\n')
  const makeObservation = (): ClaudePermissionObservation => ({
    cursor: { filePath, offset: 0, carry: '' },
    sessionId: '00000000-0000-4000-8000-000000000000',
    toolName: 'Bash',
    toolUseId: 'toolu_01QFGUSJNpFMqWgCSxXKSoRJ',
    input: {
      command: 'printf permission_probe > escape2-probe.txt',
      description: 'Write probe text to a file'
    },
    requiresUniqueInput: false,
    descendants: new Set(),
    anchored: false,
    result: false,
    proof: 'pending',
    verdict: 'working',
    failures: 0
  })
  for (const gap of ['short', 'malformed', 'line', 'carry', 'skip']) {
    writeFileSync(filePath, `${lines[0]}\n`)
    const observation = makeObservation()
    expect(readClaudePermissionObservation(observation)).toBe('complete')
    const bad =
      gap === 'malformed'
        ? 'not-json\n'
        : gap === 'line'
          ? `${'x'.repeat(256 * 1024 + 1)}\n`
          : gap === 'carry'
            ? 'x'.repeat(256 * 1024 + 1)
            : gap === 'skip'
              ? `${'{}\n'.repeat(360_000)}`
              : ''
    appendFileSync(filePath, `${lines.slice(1).join('\n')}\n${bad}`)
    io.short = gap === 'short'
    expect(readClaudePermissionObservation(observation)).toBe('lost')
    expect(observation.result).toBe(false)
    expect(observation.verdict).toBe('working')
    expect(readClaudePermissionObservation(observation)).toBe('lost')
    // A fresh full envelope may re-anchor; old prefix/fragment must not contribute.
    appendFileSync(filePath, `\n${lines.join('\n')}\n`)
    expect(readClaudePermissionObservation(observation)).toBe('complete')
    expect(observation.result).toBe(true)
    expect(observation.verdict).toBe('cancellation')
  }
  const fixture = `${lines.join('\n')}\n`
  const tool = JSON.parse(lines[0]).message.content[0]
  const fresh = fixture.replaceAll(tool.id, 'q2').replaceAll('escape2-node-', 'q2-node-')
  const make = (text: string, exact = false): ClaudePermissionObservation => {
    writeFileSync(filePath, text)
    const observation = makeObservation()
    observation.toolUseId = exact ? tool.id : undefined
    observation.requiresUniqueInput = !exact
    return observation
  }

  const read = readClaudePermissionObservation
  for (const fault of ['open', 'read', 'candidate']) {
    const o = make(fixture)
    o.toolUseId = fault === 'candidate' ? tool.id : undefined
    if (fault !== 'candidate') {
      io.fault = fault
      expect(read(o)).toBeUndefined()
    }
    read(o)
    expect(o).toMatchObject({ anchored: false, result: false, initialized: true })
  }
  for (const cut of [100, fixture.indexOf('\n', fixture.indexOf('\n') + 1) + 80]) {
    const o = make(fixture.slice(0, cut))
    o.toolUseId = tool.id // An unverified PreToolUse candidate is not a supplied PermissionRequest ID.
    read(o)
    expect(o.anchored).toBe(false)
    const reads = io.read
    read(o)
    expect(io.read).toBe(reads)
    appendFileSync(filePath, fixture.slice(cut))
    read(o)
    expect(o).toMatchObject({ anchored: false, result: false, initialized: true })
  }
  for (const cut of [100, fresh.indexOf('\n') + 80]) {
    const o = make('')
    read(o)
    appendFileSync(filePath, fresh.slice(0, cut))
    io.fault = 'read'
    expect(read(o)).toBeUndefined()
    read(o)
    expect(o.anchored).toBe(false)
    appendFileSync(filePath, fresh.slice(cut))
    expect(read(o)).toBe('complete')
    expect(o).toMatchObject({ toolUseId: 'q2', result: true, verdict: 'cancellation' })
  }
  const pending = make(`${lines[0]}\n{"type":`)
  read(pending)
  expect(pending.anchored).toBe(false)
  appendFileSync(filePath, '"metadata"}\n')
  read(pending)
  expect(pending).toMatchObject({ anchored: true, toolUseId: tool.id, result: false })
  const competing = make('')
  read(competing)
  appendFileSync(filePath, fixture + fresh.slice(0, 100))
  read(competing)
  expect(competing.anchored).toBe(false)
  appendFileSync(filePath, fresh.slice(100, fresh.indexOf('\n') + 1))
  read(competing)
  expect(competing.anchored).toBe(false)
  const exact = make(fixture.slice(0, -50), true)
  expect(read(exact)).toBe('pending')
  expect(exact).toMatchObject({ anchored: true, result: true })
  for (const fault of ['replacement', 'truncation', 'short']) {
    const o = make(`${JSON.stringify({ type: 'metadata', text: ' '.repeat(3000) })}\n`)
    read(o)
    if (fault === 'replacement') {
      renameSync(filePath, `${filePath}.old`)
    }
    writeFileSync(filePath, fixture)
    io.fault = fault === 'short' ? '' : 'read'
    io.short = fault === 'short'
    read(o)
    read(o)
    expect(o.anchored).toBe(false)
  }
  for (const excess of [-1, 0, 1, 2]) {
    const cap = 1024 * 1024
    const o = make('')
    if (excess > 0) {
      read(o)
    }
    const pad = (size: number) => `{"x":"${'x'.repeat(size - 9)}"}\n`
    const request = `${lines[0]}\n`
    const prefixSize = excess > 0 ? cap - 7 : cap + excess - Buffer.byteLength('{"x":"é"}\n')
    const prefix = request + pad(200_000).repeat(4) + pad(prefixSize - request.length - 800_000)
    const suffix = excess > 0 ? `"x":${' '.repeat(excess - 1)}0}\n{"x":"é"}\n` : '{"x":"é"}\n'
    const first = Buffer.from(excess > 0 ? `${prefix}{` : prefix + suffix)
    const second = Buffer.from(suffix)
    const split = excess > 0 ? second.indexOf(0xc3) + 1 : first.indexOf(0xc3) + 1
    const chunks =
      excess > 0
        ? [first, second.subarray(0, split)]
        : [first.subarray(0, split), first.subarray(split)]
    const before = io.bytes
    for (const [index, chunk] of chunks.entries()) {
      appendFileSync(filePath, chunk)
      read(o)
      if (index === 0) {
        expect(o.anchored).toBe(false)
      }
    }
    expect(io.bytes - before).toBe(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
    if (excess > 0) {
      expect(o).toMatchObject({
        proof: 'lost',
        acquisition: undefined,
        anchored: false,
        result: false,
        toolUseId: undefined
      })
      expect(read(o)).toBe('lost')
    } else {
      expect(io.bytes - before).toBe(cap + excess)
      expect(o).toMatchObject({ anchored: true, toolUseId: tool.id, result: false })
      expect(o.acquisition).toBeUndefined()
    }
  }
  const bounded = make('')
  read(bounded)
  const metadata = `${JSON.stringify({ type: 'metadata', text: 'x'.repeat(200_000) })}\n`
  appendFileSync(filePath, `${metadata.repeat(4)}{`)
  read(bounded)
  appendFileSync(filePath, `}\n${metadata.repeat(2)}{`)
  expect(read(bounded)).toBe('lost')
  expect(bounded).toMatchObject({ acquisition: undefined, anchored: false })
})
