import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('encodes a complete large Markdown document within a 64 MiB heap', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-markdown-html-memory-'))
  try {
    const child = join(root, 'markdown.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { encodeRawMarkdownHtmlForRichEditor } from './src/renderer/src/components/editor/raw-markdown-html';
          import { createRichMarkdownEditorCodec } from './src/renderer/src/components/editor/rich-markdown-source-transport';
          const content = '# Large document\\n\\n<div>summary</div>\\n\\n' +
            ('a'.repeat(4096) + '\\n').repeat(2048) + 'End 😊\\n';
          const codec = createRichMarkdownEditorCodec('0123456789abcdef0123456789abcdef');
          const output = encodeRawMarkdownHtmlForRichEditor(content, codec, { htmlSuperscriptLinks: true });
          console.log(JSON.stringify({
            length: output.length,
            digest: createHash('sha256').update(output).digest('hex'),
            peakRss: process.resourceUsage().maxRSS * 1024
          }));
        `,
        resolveDir: process.cwd()
      },
      outfile: child,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent'
    })
    const result = await runProcess({
      program: process.execPath,
      args: ['--max-old-space-size=64', child],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    const output: { length: number; digest: string; peakRss: number } = JSON.parse(result.stdout)
    expect(output).toMatchObject({
      length: 8_390_835,
      digest: 'ab3f696bbbb8b56cd93647b769e5ee32b9fe42550208c4792d82c9cd80d0b30e'
    })
    expect(output.peakRss).toBeLessThan(200 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
