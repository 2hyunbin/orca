import { build } from 'esbuild'
import { fork } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { smokeSessionScannerService } from './session-scanner-service-smoke.mjs'
import {
  externalNativeAddons,
  ORCAD_CHILD_ENTRY_POINTS,
  ORCAD_EXTERNAL_MODULES,
  orcadChildOutputFilename
} from './orcad-entry-build.mjs'
import { AI_VAULT_SERVICE_PROTOCOL_VERSION } from '../../src/main/ai-vault/session-scanner-service-protocol.ts'
import { AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS } from '../../src/main/ai-vault/session-scanner-service-client-state.ts'

const ENTRY = orcadChildOutputFilename(ORCAD_CHILD_ENTRY_POINTS.sessionScanner)
const directories = []
let builtDirectory

function fixtureDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-session-scanner-smoke-test-'))
  directories.push(directory)
  return directory
}

beforeAll(async () => {
  builtDirectory = fixtureDirectory()
  await build({
    entryPoints: [resolve(ORCAD_CHILD_ENTRY_POINTS.sessionScanner)],
    outfile: join(builtDirectory, ENTRY),
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    external: ORCAD_EXTERNAL_MODULES,
    plugins: [externalNativeAddons],
    logLevel: 'silent'
  })
}, 60_000)

afterAll(() => {
  for (const directory of directories) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('session scanner service build smoke', () => {
  it('lists a seeded session through the built entry', () => {
    expect(() => smokeSessionScannerService(builtDirectory)).not.toThrow()
  }, 60_000)

  it('fails when the entry is missing', () => {
    expect(() => smokeSessionScannerService(fixtureDirectory())).toThrow('smoke failed')
  })

  it('fails when the child answers without scanning', () => {
    const directory = fixtureDirectory()
    writeFileSync(
      join(directory, ENTRY),
      `process.on('message', (m) => {
        if (m.type === 'init') process.send({ type: 'ready', protocol: m.protocol, pid: process.pid })
        if (m.type === 'request') process.send({ type: 'result', id: m.id, operation: 'scan',
          value: { result: { sessions: [], issues: [] }, durationMs: 0 } })
      })`
    )
    expect(() => smokeSessionScannerService(directory)).toThrow('smoke failed')
  })
})

describe('session scanner service cancellation', () => {
  it('cancels overlapped discovery without exiting and serves the next scan', async () => {
    const files = 20
    const directory = fixtureDirectory()
    const home = join(directory, 'home')
    const sessions = join(home, '.codex', 'sessions')
    const slowDirectory = join(sessions, 'slow')
    mkdirSync(slowDirectory, { recursive: true })
    for (let n = 0; n < files; n++) {
      writeFileSync(
        join(sessions, `rollout-${n}.jsonl`),
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id: `smoke-${n}`, cwd: '/smoke' }
        })}\n`
      )
    }
    // Cancellation rejects the batch while the walker still awaits the next directory.
    const preload = join(directory, 'slow-stats.cjs')
    writeFileSync(
      preload,
      `const fsp = require('node:fs/promises'); const stat = fsp.stat; const readdir = fsp.readdir
      let stats = 0, delayed = true, release; const cancelled = new Promise((r) => { release = r })
      fsp.stat = async (...args) => { stats++; if (delayed) await cancelled; return stat(...args) }
      fsp.readdir = async (...args) => {
        if (args[0] === ${JSON.stringify(slowDirectory)} && delayed) {
          process.send({ type: 'test-discovery' }); await cancelled
          await new Promise((r) => setTimeout(r, 180))
        }
        const entries = await readdir(...args)
        return args[0] === ${JSON.stringify(sessions)}
          ? entries.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory())) : entries
      }
      process.on('message', (m) => {
        if (m?.type === 'cancel') { delayed = false; release() }
        if (m?.type === 'test-stats') process.send({ type: 'test-stats', stats })
      })`
    )
    const child = fork(join(builtDirectory, ENTRY), [], {
      execArgv: ['--require', preload],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    const next = (match) =>
      new Promise((resolve, reject) => {
        const onExit = (code, signal) => {
          child.off('message', onMessage)
          reject(new Error(`scanner exited ${code} ${signal}`))
        }
        const onMessage = (message) => {
          if (match(message)) {
            child.off('message', onMessage)
            child.off('exit', onExit)
            resolve(message)
          }
        }
        child.on('message', onMessage)
        child.once('exit', onExit)
      })
    const stats = async () => {
      const reply = next((message) => message?.type === 'test-stats')
      child.send({ type: 'test-stats' })
      return (await reply).stats
    }
    try {
      const ready = next((message) => message?.type === 'ready')
      child.send({ type: 'init', protocol: AI_VAULT_SERVICE_PROTOCOL_VERSION })
      await ready
      const reply = next((message) => message?.id === 1)
      const discovery = next((message) => message?.type === 'test-discovery')
      child.send({ type: 'request', id: 1, operation: 'scan', options: { limit: 5 } })
      await discovery
      const cancelledAt = performance.now()
      child.send({ type: 'cancel', id: 1 })
      expect((await reply).type).toBe('error')
      // Past this deadline the parent kills the child and the next scan starts cold.
      expect(performance.now() - cancelledAt).toBeLessThan(AI_VAULT_SERVICE_SHUTDOWN_TIMEOUT_MS)
      const statsAtAck = await stats()
      expect(statsAtAck).toBeGreaterThan(0)
      expect(statsAtAck).toBeLessThan(files)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(await stats()).toBe(statsAtAck)
      const successor = next((message) => message?.id === 2)
      child.send({ type: 'request', id: 2, operation: 'scan', options: { limit: 5 } })
      expect((await successor).value.result.sessions).toHaveLength(5)
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill()
    }
  }, 60_000)
})
