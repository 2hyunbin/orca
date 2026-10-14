import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'
import { buildCounterbalancedSchedule } from './counterbalanced-benchmark-schedule.mjs'
import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

const file = 'src/renderer/src/components/editor/raw-markdown-html.ts'
const baselineFile = process.argv[2]
assert.ok(baselineFile, 'Pass a saved baseline raw-markdown-html.ts as the first argument')

async function load(contents) {
  const result = await build({
    stdin: {
      contents: `${contents}\nexport { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'`,
      loader: 'ts',
      resolveDir: dirname(resolve(file))
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    banner: {
      js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(resolve('package.json'))});`
    }
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
  )
}

const arms = {
  before: await load(readFileSync(baselineFile, 'utf8')),
  after: await load(readFileSync(file, 'utf8'))
}
const key = '0123456789abcdef0123456789abcdef'
const codecs = Object.fromEntries(
  Object.entries(arms).map(([arm, module]) => [arm, module.createRichMarkdownEditorCodec(key)])
)
const fragments = [
  '[[',
  ']]',
  '[[a|alias]]',
  '\\[[literal',
  '`[[code]]`',
  '\n```\n',
  '<b>x</b>',
  '\r\n',
  '字🙂',
  'ordinary'
]
let seed = 42
for (let sample = 0; sample < 512; sample++) {
  let input = ''
  for (let part = 0; part < 20; part++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    input += fragments[seed % fragments.length]
  }
  assert.equal(
    arms.after.encodeRawMarkdownHtmlForRichEditor(input, codecs.after),
    arms.before.encodeRawMarkdownHtmlForRichEditor(input, codecs.before)
  )
}
const results = []
for (const [name, input] of [
  ['ordinary', '# Heading\nOrdinary prose with a <b>label</b>.\n'.repeat(1_000)],
  ['complete-links', 'before [[README.md|read me]] after\n'.repeat(1_000)],
  ...[2_000, 8_000, 32_000, 128_000].map((count) => [
    `unclosed-${count}`,
    `matrix ${'[[row '.repeat(count)}`
  ]),
  ['complete-before-tail', `[[README.md]] ${'[[row '.repeat(32_000)} <b>tail</b>`],
  ['protected', '\\[[literal]] `[[code]]`\n```\n[[fenced]]\n```\n[[pending']
]) {
  const invoke = (arm) => arms[arm].encodeRawMarkdownHtmlForRichEditor(input, codecs[arm])
  assert.equal(invoke('after'), invoke('before'))
  const warmupStart = performance.now()
  invoke('before')
  const iterations = Math.max(1, Math.min(100, Math.ceil(20 / (performance.now() - warmupStart))))
  invoke('after')
  const samples = { before: [], after: [] }
  const cpuSamples = { before: [], after: [] }
  for (const pair of buildCounterbalancedSchedule(10, 'before', 'after')) {
    for (const arm of pair) {
      global.gc?.()
      const start = performance.now()
      const cpuStart = process.cpuUsage()
      for (let iteration = 0; iteration < iterations; iteration++) {
        invoke(arm)
      }
      const cpu = process.cpuUsage(cpuStart)
      samples[arm].push((performance.now() - start) / iterations)
      cpuSamples[arm].push((cpu.user + cpu.system) / 1_000 / iterations)
    }
  }
  results.push({
    name,
    sourceBytes: Buffer.byteLength(input),
    iterations,
    before: summarizeBenchmarkSamples(samples.before),
    after: summarizeBenchmarkSamples(samples.after),
    samples,
    cpuSamples
  })
}
console.log(
  JSON.stringify(
    {
      baselineFile,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      parityCases: 512,
      results
    },
    null,
    2
  )
)
