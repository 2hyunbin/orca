import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('copies a complete selected Markdown file within a 64 MiB heap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-markdown-review-copy-'))
  try {
    const child = join(directory, 'copy-review.cjs')
    await build({
      stdin: {
        contents: `
          import { copyMarkdownReviewNotesForAgent } from './src/renderer/src/lib/markdown-review-note-copy';
          import { readLocalFileContent, MAX_TEXT_FILE_SIZE } from './src/main/ipc/filesystem/filesystem-file-content-inspection';
          import { createHash } from 'node:crypto';
          import { writeFileSync } from 'node:fs';
          import { join } from 'node:path';
          async function run() {
            const file = join(process.argv[2], 'README.md');
            writeFileSync(file, '- item\\n'.repeat(1_200_000));
            const { content, isBinary } = await readLocalFileContent(file);
            if (isBinary || Buffer.byteLength(content) > MAX_TEXT_FILE_SIZE) {
              throw new Error('Fixture is not a supported text file');
            }
            const note = { id: 'n1', worktreeId: 'folder-workspace', filePath: 'README.md', source: 'markdown', lineNumber: 1_200_000, startLine: 1, selectedText: content, body: 'Review this selection', createdAt: 0, side: 'modified' };
            let output = '';
            const copied = await copyMarkdownReviewNotesForAgent({ notes: [note], content, writeClipboardText: async text => { output = text } });
            console.log(JSON.stringify({ copied, sourceBytes: Buffer.byteLength(content), outputBytes: Buffer.byteLength(output), sha256: createHash('sha256').update(output).digest('hex') }));
          }
          run().catch(error => { console.error(error); process.exitCode = 1 });
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
      args: ['--max-old-space-size=64', child, directory],
      env: { ...process.env, NODE_OPTIONS: undefined, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 15_000,
      maxOutputBytes: 4096
    })
    expect(result.timedOut).toBe(false)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      copied: true,
      sourceBytes: 8_400_000,
      outputBytes: 10_800_096,
      sha256: '9aa6e92b2f749c507eb972a82022bd6b2ec7379faf8343b62c32276e48ae7bbc'
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
