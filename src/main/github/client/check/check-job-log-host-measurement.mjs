import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { runProcess } from '@orca/process-host'
import { nodeExecutable } from '../../../../../config/scripts/check-job-log-byte-cap-benchmark.mjs'

const root = process.cwd()
const directory = await mkdtemp(path.join(tmpdir(), 'orca-check-host-retention-'))
const domain = path.join(root, 'src', 'main', 'github', 'client', 'check')
const bundlePath = path.join(directory, 'host-cache.mjs')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const measuredFiles = [
  'src/main/github/client/check/check-job-log-tails.ts',
  'src/main/github/client/check/check-job-log-download.ts',
  'src/main/github/client/check/check-job-log-inflight.ts',
  'src/main/github/client/check/check-details-abort.ts',
  'src/main/github/client/check/check-details-admission-lifetime.ts',
  'src/main/git/command-runner/gh-capture-lifetime.ts',
  'src/shared/check-job-log-tail-slice.ts',
  'src/shared/check-job-log-excerpt.ts',
  'src/shared/ansi-escape-sequences.ts',
  'src/shared/utf8-byte-limits.ts',
  'src/shared/owned-utf16-suffix.ts',
  'src/shared/own-retained-string.ts'
]
const sourceHashes = {}
for (const name of measuredFiles) {
  sourceHashes[name] = hash(await readFile(path.join(root, name)))
}
const fixtureSource = `
let output = ''; let failed = false; let downloads = 0;
export function setFixtureOutput(value, error = false) { output = value; failed = error; }
export function downloadCount() { return downloads; }
export async function ghExecFileAsync() {
 downloads++;
 if (failed) throw Object.assign(new Error('fixture failed'), { code: 1, stderr: 'fixture ordinary failure' });
 return { stdout: output, stderr: '' };
}
`
try {
  const bundle = await build({
    stdin: {
      contents:
        "export { attachFailedJobLogTails, prCheckLogTailCache } from './check-job-log-tails'; export { setFixtureOutput, downloadCount } from '../../gh-utils';",
      resolveDir: domain,
      loader: 'ts'
    },
    platform: 'node',
    format: 'esm',
    bundle: true,
    write: false,
    plugins: [
      {
        name: 'generated-gh-capture-result',
        setup(builder) {
          builder.onResolve({ filter: /^\.\.\/\.\.\/gh-utils$/ }, () => ({
            path: 'generated-gh-result',
            namespace: 'fixture'
          }))
          builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
            contents: fixtureSource,
            loader: 'js'
          }))
        }
      }
    ]
  })
  await writeFile(bundlePath, bundle.outputFiles[0].text)
  const records = []
  for (let trial = 0; trial < 3; trial++) {
    const result = await runProcess({
      program: nodeExecutable(),
      args: [
        '--expose-gc',
        path.join(domain, 'check-job-log-cache-retention-child.mjs'),
        bundlePath,
        String(trial)
      ],
      cwd: root,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      maxOutputBytes: 32 * 1024
    })
    assert(
      !result.timedOut && !result.signal && result.code === 0 && !result.outputTruncated,
      'Host measurement child failed or exceeded its hard deadline'
    )
    assert.equal(result.stderr, '', 'Host measurement child emitted diagnostics')
    records.push(JSON.parse(result.stdout))
  }
  const report = {
    sourceHashes,
    bundleHash: hash(bundle.outputFiles[0].text),
    hardTimeoutMs: 20_000,
    rawCapture:
      'generated gh success boundary; actual host download/inflight/cache/extractor/sanitation',
    records
  }
  if (process.env.ORCA_CHECK_LOG_HOST_REPORT) {
    await writeFile(process.env.ORCA_CHECK_LOG_HOST_REPORT, JSON.stringify(report, null, 2))
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
