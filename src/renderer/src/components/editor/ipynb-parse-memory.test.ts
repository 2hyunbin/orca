import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('parses a supported CRLF notebook within a 128 MiB heap without losing output', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-ipynb-memory-'))
  try {
    const child = join(directory, 'parse-notebook.cjs')
    await build({
      stdin: {
        contents: `
          import { parseIpynb } from './src/renderer/src/components/editor/ipynb-parse';
          import { createHash } from 'node:crypto';
          const content = JSON.stringify({ nbformat: 4, nbformat_minor: 5,
            metadata: { language_info: { name: 'python' } },
            cells: [{ id: 'cell', cell_type: 'code', source: ['print(42)\\n'],
              outputs: [{ output_type: 'stream', name: 'stdout', text: 'go\\r\\n'.repeat(3_000_000) }] }] });
          const notebook = parseIpynb(content);
          const cell = notebook.cells[0];
          const output = cell.outputs[0];
          console.log(JSON.stringify({ bytes: Buffer.byteLength(content), language: notebook.language,
            cellCount: notebook.cells.length, id: cell.id, source: cell.source,
            outputCount: cell.outputs.length, kind: output.kind, name: output.name,
            length: output.text.length, sha256: createHash('sha256').update(output.text).digest('hex') }));
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
      args: ['--max-old-space-size=128', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      bytes: 18_000_211,
      language: 'python',
      cellCount: 1,
      id: 'cell',
      source: 'print(42)\n',
      outputCount: 1,
      kind: 'stream',
      name: 'stdout',
      length: 9_000_000,
      sha256: 'f1708195cfc9156a4c795406b6a77763cb2ac680d2031e4ab1fb996081835134'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
