import { join } from 'node:path'
import { serialize } from 'node:v8'
import { expect, vi } from 'vitest'
import type { JournalLegacyRestInitializer } from './journal-legacy-rest-initializer'
import type { JournalHostDatabase } from './journal-host-database'
import { readJournalRestFacts } from './journal-row-table'
import {
  JournalStructuralScratch,
  type JournalStructuralCheckpoint
} from './journal-structural-scratch'
import {
  JournalScratchNamespaces,
  encodeStructuralScratchKey,
  decodeStructuralScratchKey
} from './journal-structural-scratch-encoding'

export function assertScratchKeyEncoding(root: string): void {
  const ascii = 'a'.repeat(256)
  const wide = `Ω${ascii}`.slice(1)
  expect(wide).toBe(ascii)
  expect(encodeStructuralScratchKey('a')).toEqual(Buffer.from([0, 97, 0]))
  for (const key of [ascii, wide, JSON.parse(JSON.stringify(ascii))]) {
    expect(encodeStructuralScratchKey(key)).toEqual(encodeStructuralScratchKey(ascii))
  }
  for (const [text, hex] of [
    ['Ω', '00a903'],
    ['\0', '000000'],
    ['\ud800', '0000d8'],
    ['\udc00', '0000dc'],
    ['😀', '003dd800de'],
    ['\ufffd', '00fdff']
  ]) {
    expect(encodeStructuralScratchKey(text).toString('hex')).toBe(hex)
  }
  const keys = [
    '',
    'Ω',
    '\0',
    '\ud800',
    '\udc00',
    '😀',
    '\ufffd',
    0,
    -0,
    1,
    -1,
    1.25,
    Number.MAX_SAFE_INTEGER,
    2 ** 54,
    Number.NaN,
    Infinity,
    -Infinity,
    true,
    false,
    null,
    undefined,
    BigInt('12345678901234567890'),
    { id: 'Ω\0\ud800' },
    new Uint8Array([0, 255])
  ]
  const scratch = new JournalStructuralScratch(join(root, 'key-encoding.db'))
  try {
    const rows = scratch.map<unknown, number>('scalar-keys')
    keys.forEach((key, index) => {
      const encoded = encodeStructuralScratchKey(key)
      expect(decodeStructuralScratchKey(encoded)).toEqual(key)
      rows.set(key, index)
      expect(rows.get(key)).toBe(index)
      expect(rows.has(key)).toBe(true)
    })
    expect(rows.size).toBe(keys.length)
    expect(Array.from(rows)).toEqual(keys.map((key, index) => [key, index]))
    expect(encodeStructuralScratchKey('\ud800')).not.toEqual(encodeStructuralScratchKey('\ufffd'))
    expect(encodeStructuralScratchKey(0)).not.toEqual(encodeStructuralScratchKey(-0))
    expect(encodeStructuralScratchKey('1')).not.toEqual(encodeStructuralScratchKey(1))
    expect(encodeStructuralScratchKey(BigInt(1))).not.toEqual(encodeStructuralScratchKey(1))
    expect(encodeStructuralScratchKey({ id: 'x' }).subarray(1)).toEqual(serialize({ id: 'x' }))
    expect(() => encodeStructuralScratchKey(Symbol('unsupported'))).toThrow()
    keys.forEach((key) => expect(rows.delete(key)).toBe(true))
    expect(rows.size).toBe(0)
    scratch.map(ascii).set(ascii, { version: 1 })
    expect(scratch.map(wide).get(wide)).toEqual({ version: 1 })
    scratch.map(wide).set(wide, { version: 2 })
    expect(scratch.map(ascii).size).toBe(1)
    expect(Array.from(scratch.map(ascii))).toEqual([[ascii, { version: 2 }]])
    const original = { version: 3 }
    scratch.map(ascii).set(ascii, original)
    original.version = 4
    expect(scratch.map(wide).get(wide)).toEqual({ version: 3 })
  } finally {
    scratch.close()
  }
  const reopened = new JournalStructuralScratch(join(root, 'key-encoding.db'))
  try {
    expect(Array.from(reopened.map(wide))).toEqual([[ascii, { version: 3 }]])
  } finally {
    reopened.close()
  }
  const namespaces = new JournalScratchNamespaces()
  for (const name of ['Ω', '\0', '\ud800', '\udc00', '😀', '\ufffd']) {
    expect(namespaces.bind(name)).toEqual(Buffer.from(name, 'utf16le'))
  }
  const initial = namespaces.bind(ascii)
  expect(namespaces.bind(wide)).toBe(initial)
  expect(initial).toEqual(Buffer.from(ascii, 'utf16le'))
  expect(initial.buffer.byteLength).toBe(initial.byteLength)
  for (let index = 0; index < 128; index++) {
    namespaces.bind(String(index))
  }
  expect(namespaces.bind(ascii)).not.toBe(initial)
  namespaces.clear()
  const large = 'x'.repeat(513)
  expect(namespaces.bind(large)).not.toBe(namespaces.bind(large))
  const budgeted = namespaces.bind(ascii.repeat(2))
  for (let index = 0; index < 32; index++) {
    namespaces.bind(String(index).padEnd(512, 'x'))
  }
  expect(namespaces.bind(ascii.repeat(2))).not.toBe(budgeted)
  const beforeClose = namespaces.bind('closed')
  namespaces.clear()
  expect(namespaces.bind('closed')).not.toBe(beforeClose)
}

export function legacyEncodedRelations(scratch: JournalStructuralScratch) {
  return scratch.db
    .prepare('SELECT id,space,key,value FROM relations ORDER BY id')
    .all()
    .map((row) => {
      if (
        typeof row.id !== 'number' ||
        !(row.space instanceof Uint8Array) ||
        !(row.key instanceof Uint8Array) ||
        !(row.value instanceof Uint8Array)
      ) {
        throw new Error('missing real scratch prefix relation')
      }
      return {
        id: row.id,
        space: serialize(Buffer.from(row.space).toString('utf16le')),
        key: serialize(decodeStructuralScratchKey(row.key)),
        value: Buffer.from(row.value)
      }
    })
}

/** Retire real prefix metadata encoded by the previous codec; never resume it under new keys. */
export async function assertOldScratchEncodingRebuild(
  database: JournalHostDatabase,
  scratch: JournalStructuralScratch,
  saved: JournalStructuralCheckpoint,
  relations: ReturnType<typeof legacyEncodedRelations>,
  make: () => JournalLegacyRestInitializer,
  cursors: number[]
): Promise<void> {
  expect(relations.length).toBeGreaterThan(0)
  expect(scratch.db.prepare('SELECT COUNT(*) AS n FROM relations').get()?.n).toBe(0)
  const insert = scratch.db.prepare('INSERT INTO relations(id,space,key,value) VALUES(?,?,?,?)')
  for (const row of relations) {
    insert.run(row.id, row.space, row.key, row.value)
  }
  scratch.save({ ...saved, selection: { format: 6 } })
  database.db
    .prepare(
      'UPDATE journal_sessions SET open_turn_id=NULL, open_turn_since=NULL WHERE session_id=?'
    )
    .run(saved.sessionId)
  const sourceBefore = database.db
    .prepare('SELECT seq,row_json FROM journal_rows WHERE session_id=? ORDER BY seq')
    .all(saved.sessionId)
  const beforeReads = cursors.length
  let cleanups = 0
  const original = JournalStructuralScratch.prototype.cleanupStep
  const cleanup = vi
    .spyOn(JournalStructuralScratch.prototype, 'cleanupStep')
    .mockImplementation(function (limit, canWork) {
      try {
        return original.call(this, limit, canWork)
      } finally {
        cleanups++
      }
    })
  const first = make()
  try {
    await first.advance(() => cleanups === 0)
  } finally {
    await first.close()
    cleanup.mockRestore()
  }
  const remaining = Number(scratch.db.prepare('SELECT COUNT(*) AS n FROM relations').get()?.n)
  expect(relations.length - remaining).toBeGreaterThan(0)
  expect(relations.length - remaining).toBeLessThanOrEqual(32)
  expect(scratch.load<{ cleanup: boolean; sessionId: string }>()).toEqual({
    cleanup: true,
    sessionId: saved.sessionId
  })
  expect(cursors.length).toBe(beforeReads)
  expect(readJournalRestFacts(database.db, saved.sessionId)?.known).toBe(false)
  const resumed = make()
  try {
    await resumed.advance(() => true)
  } finally {
    await resumed.close()
  }
  expect(cursors[beforeReads]).toBe(0)
  expect(new Set(cursors.slice(beforeReads)).size).toBe(sourceBefore.length + 1)
  expect(scratch.load()).toBeUndefined()
  expect(scratch.db.prepare('SELECT COUNT(*) AS n FROM relations').get()?.n).toBe(0)
  expect(
    database.db
      .prepare('SELECT seq,row_json FROM journal_rows WHERE session_id=? ORDER BY seq')
      .all(saved.sessionId)
  ).toEqual(sourceBefore)
}
