import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const { values } = parseArgs({
  options: {
    'baseline-source': { type: 'string' },
    parent: { type: 'string', default: tmpdir() },
    rounds: { type: 'string', default: '9' },
    rows: { type: 'string', default: '5000,50000' },
    output: { type: 'string' },
    help: { type: 'boolean', default: false }
  }
})
if (values.help) {
  console.log(
    'Usage: node config/scripts/codex-title-index-read-benchmark.mjs --baseline-source <saved-reader.ts> [--parent <native-dir-or-WSL-UNC-dir>] [--rounds 9] [--rows 5000,50000] [--output <result.json>]\nRun from Windows with --parent //wsl.localhost/Ubuntu-24.04/tmp to measure actual WSL reads.'
  )
  process.exit(0)
}
assert(values['baseline-source'], '--baseline-source must name the saved pre-change reader source')
const rounds = Number(values.rounds)
const sizes = values.rows.split(',').map(Number)
assert(Number.isSafeInteger(rounds) && rounds > 0, '--rounds must be a positive integer')
assert(
  sizes.every((count) => Number.isSafeInteger(count) && count >= 8),
  '--rows must contain comma-separated integers of at least 8'
)
const repository = fileURLToPath(new URL('../../', import.meta.url))
const sourceDir = join(repository, 'src', 'main', 'ai-vault')
const sources = {
  before: await readFile(values['baseline-source'], 'utf8'),
  after: await readFile(join(sourceDir, 'session-scanner-codex-title-index.ts'), 'utf8')
}
const parent = resolve(values.parent)
const buildDir = await mkdtemp(join(tmpdir(), 'orca-codex-title-build-'))
let scratch
process.env.ORCA_BACKGROUND_LAUNCH = '1'
// Production filesystem children are unref'ed; pending reads alone cannot keep Node alive.
const keepAlive = setInterval(() => {}, 1000)
try {
  const buildOptions = { bundle: true, platform: 'node', format: 'cjs', target: 'node24' }
  for (const [variant, contents] of Object.entries(sources)) {
    await build({
      ...buildOptions,
      stdin: { contents, resolveDir: sourceDir, sourcefile: `${variant}.ts`, loader: 'ts' },
      outfile: join(buildDir, `${variant}.cjs`)
    })
  }
  // The real reader locates its child entry beside its own bundle.
  await build({
    ...buildOptions,
    entryPoints: [
      join(repository, 'src', 'main', 'native-chat', 'wsl-transcript-fs-process-entry.ts')
    ],
    outfile: join(buildDir, 'wsl-transcript-fs-process-entry.js')
  })
  const require = createRequire(import.meta.url)
  const variants = {
    before: require(join(buildDir, 'before.cjs')),
    after: require(join(buildDir, 'after.cjs'))
  }
  scratch = await mkdtemp(join(parent, 'orca-codex-title-bench-'))
  const title = (index) => `Review source control polling and status publication number ${index}`
  const median = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
  }
  const result = {
    node: process.version,
    platform: process.platform,
    parent,
    rounds,
    concurrency: 8,
    syscallSubstitution: false,
    sourceSha256: Object.fromEntries(
      Object.entries(sources).map(([variant, source]) => [
        variant,
        createHash('sha256').update(source).digest('hex')
      ])
    ),
    methodology:
      'Alternating before/after pairs; cold title caches; real production filesystem reader and WSL child. Build, corpus writes, and title assertions are outside timing. This measures a title lookup batch, not total app latency.',
    cases: []
  }
  for (const count of sizes) {
    const sessionIds = Array.from({ length: 8 }, (_, index) =>
      Math.floor((index * (count - 1)) / 7)
    )
    const expected = sessionIds.map(title)
    const body = `${Array.from({ length: count }, (_, index) =>
      JSON.stringify({
        id: String(index),
        thread_name: title(index),
        updated_at: '2026-10-13T12:00:00.000Z'
      })
    ).join('\n')}\n`
    await writeFile(join(scratch, 'session_index.jsonl'), body)
    const samples = { before: [], after: [] }
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? ['before', 'after'] : ['after', 'before']
      for (const variant of order) {
        variants[variant].resetCodexSessionIndexTitleCacheForTests()
        const start = performance.now()
        const titles = await Promise.all(
          sessionIds.map((sessionId) =>
            variants[variant].readCodexSessionIndexTitle(
              join(scratch, 'sessions', 'session.jsonl'),
              scratch,
              String(sessionId)
            )
          )
        )
        const elapsed = performance.now() - start
        assert.deepEqual(titles, expected, `${variant} title parity failed`)
        samples[variant].push(elapsed)
      }
    }
    const beforeMedianMs = median(samples.before)
    const afterMedianMs = median(samples.after)
    result.cases.push({
      rows: count,
      corpusBytes: Buffer.byteLength(body),
      beforeMedianMs,
      afterMedianMs,
      improvementPercent: 100 * (1 - afterMedianMs / beforeMedianMs),
      samples
    })
  }
  const json = `${JSON.stringify(result, null, 2)}\n`
  if (values.output) {
    await writeFile(values.output, json)
  }
  console.log(json)
} finally {
  try {
    if (scratch) {
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  } finally {
    try {
      await rm(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } finally {
      clearInterval(keepAlive)
    }
  }
}
