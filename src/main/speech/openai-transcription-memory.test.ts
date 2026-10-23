import { runProcess } from '@orca/process-host'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { expect, it } from 'vitest'

it('uploads every sample of a long dictation without full-recording intermediate copies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-transcription-memory-'))
  try {
    const child = join(root, 'transcription.cjs')
    await build({
      stdin: {
        contents: `
          import { createHash } from 'node:crypto';
          import { OpenAiTranscriptionSession } from './src/main/speech/openai-transcription-client';
          const sampleCount = 599 * 16000;
          const block = new Float32Array(4096);
          for (let i = 0; i < block.length; i++) block[i] = ((i % 257) - 128) / 64;
          const session = new OpenAiTranscriptionSession('openai-gpt-4o-mini-transcribe', () => 'unused');
          for (let i = 0; i < sampleCount; i += block.length) {
            session.feedAudio(block.subarray(0, Math.min(block.length, sampleCount - i)), 16000);
          }
          let digest;
          let bytes = 0;
          let audioBufferBytes;
          globalThis.fetch = async (_url, init) => {
            audioBufferBytes = process.memoryUsage().arrayBuffers;
            const file = init.body.get('file');
            const hash = createHash('sha256');
            for await (const chunk of file.stream()) {
              hash.update(chunk);
              bytes += chunk.byteLength;
            }
            digest = hash.digest('hex');
            return new Response(JSON.stringify({ text: ' complete dictation ' }));
          };
          session.finish().then((text) => console.log(JSON.stringify({ text, bytes, digest, audioBufferBytes })));
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
    const output: { text: string; bytes: number; digest: string; audioBufferBytes: number } =
      JSON.parse(result.stdout)
    expect(output).toMatchObject({
      text: 'complete dictation',
      bytes: 19_168_044,
      digest: 'bd02ed59e46f63bf678b902c91e7572f30150307b3d72cdd5ad7e0eac6766492'
    })
    expect(output.audioBufferBytes).toBeLessThan(100 * 1024 * 1024)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
