import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import Module from 'node:module'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { build } from 'esbuild'

// Run from the worktree root: node config/scripts/zod-validation-benchmark.mjs <base-ref>
const baselineRef = process.argv[2]
assert.ok(baselineRef, 'Pass the pre-change revision as base-ref.')

async function loadParsers(path) {
  const baseline = execFileSync('git', ['show', `${baselineRef}:${path}`], { encoding: 'utf8' })
  const parsers = []
  for (const contents of [baseline, readFileSync(path, 'utf8')]) {
    const built = await build({
      stdin: { contents, loader: 'ts', resolveDir: dirname(resolve(path)) },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      write: false,
      logLevel: 'silent'
    })
    const module = new Module(resolve(path))
    module.paths = Module._nodeModulePaths(resolve('.'))
    module._compile(built.outputFiles[0].text, resolve(path))
    parsers.push(module.exports)
  }
  return parsers
}

function measure(fn, input, iterations) {
  let accepted = 0
  const start = performance.now()
  for (let iteration = 0; iteration < iterations; iteration++) {
    if (fn(input)) {
      accepted++
    }
  }
  assert.equal(accepted, fn(input) ? iterations : 0)
  return ((performance.now() - start) * 1e6) / iterations
}

function compare(name, before, after, input, iterations = 10_000) {
  const start = performance.now()
  const original = before(input)
  const beforeFirstMs = performance.now() - start
  const afterStart = performance.now()
  const result = after(input)
  const afterFirstMs = performance.now() - afterStart
  assert.deepEqual(result, original)
  for (let iteration = 0; iteration < 2_000; iteration++) {
    before(input)
    after(input)
  }
  const beforeSamples = []
  const afterSamples = []
  for (let sample = 0; sample < 7; sample++) {
    // Alternate order so the second parser does not always benefit from a warmed process.
    if (sample % 2 === 0) {
      beforeSamples.push(measure(before, input, iterations))
      afterSamples.push(measure(after, input, iterations))
    } else {
      afterSamples.push(measure(after, input, iterations))
      beforeSamples.push(measure(before, input, iterations))
    }
  }
  const beforeNs = beforeSamples.sort((a, b) => a - b)[3]
  const afterNs = afterSamples.sort((a, b) => a - b)[3]
  return {
    case: name,
    beforeNs: Math.round(beforeNs),
    afterNs: Math.round(afterNs),
    speedup: (beforeNs / afterNs).toFixed(2),
    beforeFirstMs: beforeFirstMs.toFixed(2),
    afterFirstMs: afterFirstMs.toFixed(2)
  }
}

const results = []
const [beforeSubmission, afterSubmission] = await loadParsers(
  'src/shared/agent-session-journal-submission-schema.ts'
)
const submission = {
  clientMessageId: 'client-1',
  fence: 1,
  payloadFingerprint: 'fingerprint',
  dispatchState: 'accepted',
  providerItemId: null,
  reason: null,
  submittedAt: 1,
  resolvedAt: null
}
for (const [name, input] of [
  ['submission: valid', submission],
  ['submission: invalid', { ...submission, clientMessageId: 12 }]
]) {
  results.push(
    compare(
      name,
      beforeSubmission.isAdmissibleAgentJournalSubmission,
      afterSubmission.isAdmissibleAgentJournalSubmission,
      input
    )
  )
}

const [beforeContext, afterContext] = await loadParsers(
  'src/shared/agent-session-context-usage-schema.ts'
)
const report = {
  kind: 'report',
  model: 'model-1',
  usedTokens: 100,
  windowTokens: 1_000,
  percentage: 10,
  categories: [{ name: 'messages', tokens: 100 }],
  capturedAt: 1
}
for (const [name, input] of [
  ['context: report', { used: report, window: { tokens: 1_000, capturedAt: 1 } }],
  [
    'context: estimate',
    {
      used: {
        kind: 'estimate',
        usage: {
          inputTokens: 100,
          outputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0
        },
        capturedAt: 1
      }
    }
  ],
  ['context: unknown', { used: { kind: 'unknown', capturedAt: 1 } }],
  ['context: invalid', { used: { ...report, usedTokens: -1 } }]
]) {
  results.push(
    compare(
      name,
      beforeContext.isAdmissibleAgentSessionContextUsage,
      afterContext.isAdmissibleAgentSessionContextUsage,
      input
    )
  )
}

const [beforeAcp, afterAcp] = await loadParsers('src/main/acp/acp-session-events.ts')
for (const [name, update] of [
  ['ACP: text', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hello' } }],
  [
    'ACP: tool',
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'tool-1',
      title: 'Read',
      kind: 'read',
      status: 'pending',
      locations: [{ path: 'file.ts', line: 1 }],
      content: []
    }
  ],
  ['ACP: future kind', { sessionUpdate: 'vendor_usage', tokens: 1 }],
  [
    'ACP: malformed text',
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 1 } }
  ]
]) {
  results.push(
    compare(
      name,
      beforeAcp.readAcpSessionEvent,
      afterAcp.readAcpSessionEvent,
      { sessionId: 'session-1', update },
      name.includes('future') || name.includes('malformed') ? 1_000 : 10_000
    )
  )
}

console.log(`Zod ${JSON.parse(readFileSync('node_modules/zod/package.json', 'utf8')).version}`)
console.table(results)
