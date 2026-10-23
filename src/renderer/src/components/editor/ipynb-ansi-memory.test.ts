import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('parses complete notebook progress output within a 96 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-ipynb-ansi-memory-'))
  try {
    const child = join(directory, 'notebook-output.cjs')
    await build({
      stdin: {
        contents: `
          import { parseIpynb } from './src/renderer/src/components/editor/ipynb-parse';
          import { parseAnsiSegments } from './src/renderer/src/components/editor/ipynb-ansi';
          import { createHash } from 'node:crypto';
          const NativeBuffer = Buffer;
          globalThis.Buffer = undefined;
          const content = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {},
            cells: [{ cell_type: 'code', source: 'print(1)', metadata: {}, execution_count: 1,
              outputs: [{ output_type: 'stream', name: 'stdout', text: 'x\\x1b[K'.repeat(3_000_000) }] }] });
          const notebook = parseIpynb(content);
          const output = notebook.cells[0].outputs[0];
          if (output.kind !== 'stream') throw new Error('Missing complete stream output');
          const segments = parseAnsiSegments(output.text);
          console.log(JSON.stringify({ notebookBytes: NativeBuffer.byteLength(content),
            retainedBytes: NativeBuffer.byteLength(output.text), count: segments.length,
            textBytes: NativeBuffer.byteLength(segments[0].text),
            sha256: createHash('sha256').update(segments[0].text).digest('hex') }));
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent'
    })
    const result = await runProcess({
      program: process.execPath,
      args: ['--max-old-space-size=96', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      notebookBytes: 27_000_195,
      retainedBytes: 12_000_000,
      count: 1,
      textBytes: 3_000_000,
      sha256: 'e55b8bdf621ddaa8f462c74745db9680d3bb7536a9cf854f8d6668b34a287890'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
