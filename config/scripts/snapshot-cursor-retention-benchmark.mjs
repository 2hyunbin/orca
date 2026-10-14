#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from '@playwright/test'
import { runProcess, spawnProcess } from '@orca/process-host'
import { forceTerminateProcessTree } from '@orca/process-host/process-tree-termination'
import { build } from 'esbuild'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')
const sourcePath = 'src/main/browser/snapshot-cursor-interactive-elements.ts'
const cycles = 100
const controls = 50

function parseOptions() {
  const options = { revision: '', expect: 'released' }
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!['--revision', '--expect'].includes(flag) || !value || value.startsWith('-')) {
      throw new Error('Usage: --revision <git-ref> --expect <retained|released>')
    }
    options[flag.slice(2)] = value
  }
  assert.ok(['retained', 'released'].includes(options.expect), 'Invalid --expect value')
  return options
}

async function readSource(revision) {
  if (!revision) {
    return readFile(path.join(repoRoot, sourcePath), 'utf8')
  }
  const result = await runProcess({
    program: 'git',
    args: ['show', `${revision}:${sourcePath}`],
    cwd: repoRoot,
    maxOutputBytes: 1024 * 1024,
    killOnOutputLimit: true
  })
  assert.equal(result.code, 0, result.stderr || 'Cannot read the selected Git revision')
  return result.stdout
}

function waitForEndpoint(child) {
  return new Promise((resolve, reject) => {
    let diagnostics = ''
    const timer = setTimeout(() => reject(new Error(`CDP startup timeout: ${diagnostics}`)), 30_000)
    child.stderr.on('data', (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-16_384)
      const endpoint = diagnostics.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]
      if (endpoint) {
        clearTimeout(timer)
        resolve(endpoint)
      }
    })
    const fail = (error) => {
      clearTimeout(timer)
      reject(error)
    }
    child.stderr.on('error', fail)
    child.once('error', fail)
    child.once('exit', (code) => fail(new Error(`Electron exited ${code}: ${diagnostics}`)))
  })
}

async function measure(browser, options, source) {
  const context = browser.contexts()[0]
  let page
  for (let attempt = 0; attempt < 100 && !page; attempt += 1) {
    page = context.pages().find((candidate) => candidate.url().startsWith('data:text/html'))
    if (!page) {
      await sleep(50)
    }
  }
  assert.ok(page, 'Hidden fixture renderer not found')
  await page.waitForFunction(() => document.title === 'orca-cursor-retention-fixture')
  const cdp = await context.newCDPSession(page)
  const collect = async () => {
    for (let pass = 0; pass < 3; pass += 1) {
      await cdp.send('HeapProfiler.collectGarbage')
    }
    return cdp.send('Memory.getDOMCounters')
  }
  const initial = await collect()
  const samples = []
  let entries
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    await page.evaluate(
      ({ cycle, controls }) => {
        const container = document.createElement('main')
        for (let index = 0; index < controls; index += 1) {
          const row = document.createElement('div')
          row.style.cursor = 'pointer'
          row.textContent = `cycle-${cycle}-row-${index}-${'x'.repeat(8192)}`
          container.append(row)
        }
        document.body.replaceChildren(container)
      },
      { cycle, controls }
    )
    entries = await source.findCursorInteractiveElements(
      (method, params) => cdp.send(method, params),
      []
    )
    assert.equal(entries.length, controls, 'Cursor discovery changed')
    if ((cycle + 1) % 20 === 0) {
      samples.push({ cycle: cycle + 1, ...(await collect()) })
    }
  }
  const { object } = await cdp.send('DOM.resolveNode', {
    backendNodeId: entries[0].backendDOMNodeId
  })
  const { result } = await cdp.send('Runtime.callFunctionOn', {
    objectId: object.objectId,
    functionDeclaration: 'function() { return this.textContent.slice(0, 32) }',
    returnByValue: true
  })
  await cdp.send('Runtime.releaseObject', { objectId: object.objectId })
  assert.ok(result.value.startsWith(`cycle-${cycles - 1}-row-0-`), 'Backend reference changed')
  await page.evaluate(() => document.body.replaceChildren())
  // Flush pending layout references before counting detached nodes.
  await page.evaluate(() => document.body.getBoundingClientRect().height)
  const final = await collect()
  const retainedNodes = final.nodes - initial.nodes
  return {
    revision: options.revision || 'working tree',
    expect: options.expect,
    platform: process.platform,
    runtime: await cdp.send('Browser.getVersion'),
    cycles,
    controls,
    initial,
    samples,
    final,
    retainedNodes,
    backendRefAfterCleanup: result.value
  }
}

assert.equal(process.env.ORCA_BACKGROUND_LAUNCH, '1', 'Set ORCA_BACKGROUND_LAUNCH=1')
const options = parseOptions()
const source = await readSource(options.revision)
const temporaryDir = await mkdtemp(path.join(tmpdir(), 'orca-cursor-retention-'))
let browser
let child
let exited
const stop = () => {
  if (child && !child.stdin.destroyed) {
    child.stdin.end()
  }
}
try {
  const bundlePath = path.join(temporaryDir, 'snapshot.cjs')
  await build({
    stdin: {
      contents: source,
      loader: 'ts',
      resolveDir: path.join(repoRoot, path.dirname(sourcePath))
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundlePath
  })
  const require = createRequire(import.meta.url)
  const env = { ...process.env, ORCA_CURSOR_RETENTION_PROFILE: temporaryDir }
  delete env.ELECTRON_RUN_AS_NODE
  child = spawnProcess({
    program: require('electron'),
    args: [
      path.join(import.meta.dirname, 'snapshot-cursor-retention-electron.cjs'),
      '--remote-debugging-port=0'
    ],
    cwd: repoRoot,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'ignore', 'pipe']
  })
  child.stdin.on('error', () => {})
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  exited = new Promise((resolve) => {
    child.once('exit', () => resolve(true))
    child.once('error', () => resolve(true))
  })
  browser = await chromium.connectOverCDP(await waitForEndpoint(child))
  const report = await measure(browser, options, require(bundlePath))
  report.sourceSha256 = createHash('sha256').update(source).digest('hex')
  console.log(JSON.stringify(report, null, 2))
  if (options.expect === 'retained') {
    assert.ok(
      report.retainedNodes >= cycles * controls * 2,
      'Baseline did not reproduce retained DOM'
    )
  } else {
    assert.ok(
      report.retainedNodes <= 10,
      `Removed DOM is still retained: ${report.retainedNodes} nodes`
    )
    assert.ok(
      report.samples.at(-1).nodes - report.samples[0].nodes <= 10,
      'DOM retention grows across snapshots'
    )
  }
} finally {
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  if (browser) {
    await Promise.race([browser.close().catch(() => {}), sleep(2_000)])
  }
  if (child) {
    stop()
    if (!(await Promise.race([exited, sleep(2_000, false)]))) {
      assert.equal(
        await forceTerminateProcessTree(child),
        true,
        'Cannot stop the fixture process tree'
      )
      assert.equal(
        await Promise.race([exited, sleep(2_000, false)]),
        true,
        `Fixture has not exited; keeping profile at ${temporaryDir}`
      )
    }
  }
  await rm(temporaryDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
