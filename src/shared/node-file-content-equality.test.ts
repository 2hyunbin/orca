import {
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  truncateSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES,
  nodeFileContentsEqual,
  nodeFileContentsEqualSync,
  nodeFilesEqualSync
} from './node-file-content-equality'

const roots: string[] = []

function createFile(contents: string): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-file-content-equality-'))
  roots.push(root)
  const filePath = join(root, 'owned-launcher')
  writeFileSync(filePath, contents)
  return filePath
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('Node file content equality', () => {
  it('compares UTF-8 content without changing its bytes', async () => {
    const filePath = createFile('launch 🐋\n')

    await expect(nodeFileContentsEqual(filePath, 'launch 🐋\n')).resolves.toBe(true)
    expect(nodeFileContentsEqualSync(filePath, 'launch 🐋\n')).toBe(true)
    await expect(nodeFileContentsEqual(filePath, 'different\n')).resolves.toBe(false)
    expect(nodeFileContentsEqualSync(filePath, 'different\n')).toBe(false)
  })

  it('rejects a large sparse replacement from metadata without reading its payload', async () => {
    const filePath = createFile('owned launcher\n')
    truncateSync(filePath, 256 * 1024 * 1024)

    await expect(nodeFileContentsEqual(filePath, 'owned launcher\n')).resolves.toBe(false)
    expect(nodeFileContentsEqualSync(filePath, 'owned launcher\n')).toBe(false)
  })

  it.each([0, NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES, NODE_FILE_CONTENT_COMPARE_CHUNK_BYTES + 3])(
    'compares two files of %i bytes including their final byte',
    (length) => {
      const first = createFile('')
      const second = createFile('')
      const contents = Buffer.alloc(length, 0xa5)
      writeFileSync(first, contents)
      writeFileSync(second, contents)
      expect(nodeFilesEqualSync(first, second)).toBe(true)
      if (length > 0) {
        const fd = openSync(second, 'r+')
        try {
          writeSync(fd, Buffer.from([0x5a]), 0, 1, length - 1)
        } finally {
          closeSync(fd)
        }
        expect(nodeFilesEqualSync(first, second)).toBe(false)
      }
      truncateSync(second, length + 1)
      expect(nodeFilesEqualSync(first, second)).toBe(false)
    }
  )
})
