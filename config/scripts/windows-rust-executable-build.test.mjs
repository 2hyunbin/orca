import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import { publishBuiltExecutable } from './windows-rust-executable-build.mjs'

const roots = []

function tempDir() {
  const root = mkdtempSync(join(tmpdir(), 'orca-rust-publish-'))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('publishBuiltExecutable', () => {
  it('leaves an identical output untouched, so concurrent builds do not rewrite it', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'built.exe'), 'binary')
    writeFileSync(join(dir, 'out.exe'), 'binary')
    const past = new Date(Date.now() - 60_000)
    utimesSync(join(dir, 'out.exe'), past, past)

    publishBuiltExecutable(join(dir, 'built.exe'), join(dir, 'out.exe'))

    expect(statSync(join(dir, 'out.exe')).mtimeMs).toBe(past.getTime())
  })

  it('replaces a different output and leaves no staging file behind', () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'built.exe'), 'next')
    writeFileSync(join(dir, 'out.exe'), 'previous')

    publishBuiltExecutable(join(dir, 'built.exe'), join(dir, 'out.exe'))

    expect(readFileSync(join(dir, 'out.exe'), 'utf8')).toBe('next')
    expect(readdirSync(dir).sort()).toEqual(['built.exe', 'out.exe'])
  })

  it('lets parallel builds publish the same output without a busy-file failure', async () => {
    const dir = tempDir()
    const output = join(dir, 'out.exe')
    const moduleUrl = pathToFileURL(join(import.meta.dirname, 'windows-rust-executable-build.mjs'))
    const children = Array.from({ length: 8 }, (_, index) => {
      const built = join(dir, `built-${index}.exe`)
      // Distinct bytes force every child onto the stage-and-rename path at once.
      writeFileSync(built, `binary-${index}`.repeat(50_000))
      const script = `import(${JSON.stringify(moduleUrl.href)}).then((m) => m.publishBuiltExecutable(${JSON.stringify(built)}, ${JSON.stringify(output)}))`
      return new Promise((resolve) => {
        const child = spawnProcess({ program: process.execPath, args: ['-e', script] })
        child.on('close', (code) => resolve(code))
      })
    })

    expect(await Promise.all(children)).toEqual(Array(8).fill(0))
    expect(readFileSync(output, 'utf8')).toMatch(/^(binary-\d)+$/)
    expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
