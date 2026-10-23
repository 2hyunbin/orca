import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'

let scratch = ''
let childPath = ''

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'orca-markdown-find-memory-'))
  childPath = join(scratch, 'search.cjs')
  await build({
    stdin: {
      contents: `
        import { findTextMatchRanges } from './src/renderer/src/components/editor/markdown-preview-search';
        const size = process.argv[2] === 'unicode' ? 512 * 1024 : 600 * 1024;
        const suffix = process.argv[2] === 'unicode' ? '😊İNEEDLE' : 'NEEDLE';
        const text = 'x'.repeat(size - suffix.length) + suffix;
        process.stdout.write(JSON.stringify(findTextMatchRanges(text, 'needle')));
      `,
      resolveDir: process.cwd()
    },
    outfile: childPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterAll(async () => {
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

describe('Markdown Find memory budget', () => {
  it.each([
    { kind: 'ascii', sizeKiB: 600, start: 614394, end: 614400 },
    { kind: 'unicode', sizeKiB: 512, start: 524282, end: 524288 }
  ])(
    'searches a $sizeKiB KiB $kind paragraph within a 32 MiB heap',
    async ({ kind, start, end }) => {
      // A separate heap makes the allocation regression independent of the test worker's load.
      const result = await runProcess({
        program: process.execPath,
        args: ['--max-old-space-size=32', childPath, kind],
        env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 10_000,
        maxOutputBytes: 4096
      })
      expect(result.timedOut).toBe(false)
      expect(result.code, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual([{ start, end }])
    }
  )
})
