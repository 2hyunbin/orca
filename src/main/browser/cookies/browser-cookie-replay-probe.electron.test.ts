import { spawnSync } from 'node:child_process'
import { createCipheriv, createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { build } from 'vite'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'

const shapes = [
  { name: 'high-byte', value: '\u0080\u00a3\u00e9\u00ff' },
  { name: 'none-insecure', value: 'none', isSecure: 0 as const, sameSite: 0 as const },
  { name: 'control-chars', value: 'before\u0001\u0009\u000a\u000d\u007fafter' },
  { name: 'oversized', value: 'x'.repeat(4096) },
  { name: 'empty-host-hash', value: '' },
  { name: 'plain-valid', value: 'synthetic-valid' }
]

function fixture(bundle: string, root: string): string {
  return `
const { app, BrowserWindow, session } = require('electron')
const { existsSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { createServer } = require('node:http')
const api = require(${JSON.stringify(bundle)})
const root = ${JSON.stringify(root)}
const mode = process.argv.find(v => v.startsWith('--probe-mode=')).split('=')[1]
const partition = 'persist:e1-replay'
const metadata = { resolveMetadataPath: () => join(root, 'metadata.json'), defaultPartition: partition }
const resultPath = join(root, mode + '.json')
const names = ${JSON.stringify(shapes.map((s) => s.name))}
app.setPath('userData', join(root, 'profile'))
app.on('window-all-closed', () => {})
async function run() {
  const timer = setTimeout(() => { throw new Error('E1 fixture timeout') }, 60000)
  await app.whenReady()
  if (mode === 'replay') api.applyPendingBrowserCookieImports({ ...metadata, activeOrcaProfileId: 'e1' })
  const target = session.fromPartition(partition)
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  await window.loadURL('data:text/html,<title>E1 synthetic fixture</title>')
  let importResult
  if (mode === 'live') {
    globalThis.e1SetPending = (p, path) => api.setPendingBrowserCookieImport({ ...metadata, partition: p, stagingDbPath: path })
    globalThis.e1ClearPending = (p) => api.clearPendingBrowserCookieImport({ ...metadata, partition: p })
    importResult = await api.importCookiesFromBrowser({ family: 'chrome', label: 'E1 synthetic Chromium', cookiesPath: join(root, 'source.db'), profiles: [], selectedProfile: '' }, partition)
    if (!importResult.ok) throw new Error(JSON.stringify(importResult))
  }
  const cookies = await target.cookies.get({})
  const server = createServer((req, res) => {
    const header = req.headers.cookie || ''
    writeFileSync(join(root, mode + '-header.json'), JSON.stringify({ header, rawHeaders: req.rawHeaders }))
    res.end('<title>E1 received</title>')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.E1_PROBE_PORT || 9480), '127.0.0.1', resolve) })
  await window.loadURL('http://127.0.0.1:' + server.address().port + '/')
  const received = JSON.parse(readFileSync(join(root, mode + '-header.json'), 'utf8'))
  const pairs = received.header.split('; ').map(v => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)] })
  const rows = names.map(name => {
    const cookie = cookies.find(c => c.name === name)
    const sent = pairs.find(([n]) => n === name)
    return { name, present: !!cookie, value: cookie?.value, secure: cookie?.secure, sent: !!sent, sentValue: sent?.[1] }
  })
  const pending = existsSync(metadata.resolveMetadataPath()) ? JSON.parse(readFileSync(metadata.resolveMetadataPath(), 'utf8')) : null
  writeFileSync(resultPath, JSON.stringify({ mode, versions: process.versions, platform: process.platform, release: require('node:os').release(), importResult, rows, received, pending }, null, 2))
  await target.cookies.flushStore()
  await new Promise(resolve => server.close(resolve))
  window.destroy()
  clearTimeout(timer)
  app.quit()
}
run().catch(error => { writeFileSync(resultPath, JSON.stringify({ error: String(error.stack || error) })); app.exit(1) })
`
}

describe('E1 native Chromium live import versus cold-start staged replay', () => {
  it('measures all shapes and valid siblings on the server receiving the request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-e1-replay-'))
    console.log('E1_EVIDENCE_ROOT', root)
    const sourcePath = join(root, 'source.db')
    const key = Buffer.alloc(16, 42)
    const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    const encryptedEmpty = Buffer.concat([
      Buffer.from('v10'),
      cipher.update(createHash('sha256').update('127.0.0.1').digest()),
      cipher.final()
    ])
    const source = createChromiumCookieTestDatabase(
      sourcePath,
      shapes.map((s) => ({
        ...s,
        domain: '127.0.0.1',
        isSecure: s.isSecure ?? 1,
        encryptedValue: s.name === 'empty-host-hash' ? encryptedEmpty : undefined
      }))
    )
    // Keep raw bytes in the source, without SQLite's UTF-8 text decoding changing them.
    source
      .prepare('UPDATE cookies SET value = ? WHERE name = ?')
      .run(Buffer.from(shapes[0].value, 'latin1'), 'high-byte')
    // Persist across Chromium's normal shutdown and restart.
    source.exec(
      'ALTER TABLE cookies ADD COLUMN has_expires INTEGER NOT NULL DEFAULT 1; ALTER TABLE cookies ADD COLUMN is_persistent INTEGER NOT NULL DEFAULT 1'
    )
    source
      .prepare('UPDATE cookies SET expires_utc = ?')
      .run(BigInt(Date.now() + 86400000) * 1000n + 11644473600000000n)
    source.close()
    const entry = join(root, 'entry.ts')
    const bundle = join(root, 'import.cjs')
    const registry = join(root, 'registry.cjs')
    const keyModule = join(root, 'key.cjs')
    writeFileSync(
      registry,
      'exports.browserSessionRegistry = { setPendingCookieImport: (...args) => globalThis.e1SetPending(...args), clearPendingCookieImport: (...args) => globalThis.e1ClearPending(...args) }'
    )
    writeFileSync(
      keyModule,
      'exports.getEncryptionKey = () => ({ mode: "aes-128-cbc", keysByVersion: { v10: Buffer.alloc(16, 42) } })'
    )
    writeFileSync(
      entry,
      [
        `export { importCookiesFromBrowser } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/cookies/browser-cookie-import.ts'))}`,
        `export { applyPendingBrowserCookieImports, setPendingBrowserCookieImport, clearPendingBrowserCookieImport } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/browser-session-cookie-staging.ts'))}`
      ].join('\n')
    )
    await build({
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'e1-synthetic-boundaries',
          resolveId(source) {
            if (source.endsWith('/browser-session-registry')) {
              return registry
            }
            if (source.endsWith('/browser-cookie-key')) {
              return keyModule
            }
            return null
          }
        }
      ],
      build: {
        emptyOutDir: false,
        lib: { entry, formats: ['cjs'], fileName: () => 'import.cjs' },
        outDir: root,
        target: 'node20',
        rollupOptions: { external: ['electron', /^node:/] }
      }
    })
    const main = join(root, 'main.cjs')
    writeFileSync(main, fixture(bundle, root))
    const home = join(root, 'home')
    mkdirSync(home)
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...env } = process.env
    const electron = createRequire(import.meta.url)('electron')
    for (const mode of ['live', 'replay']) {
      const args = [main, `--probe-mode=${mode}`, '--password-store=basic', '--use-mock-keychain']
      const result = spawnSync(electron, args, {
        encoding: 'utf8',
        timeout: 90000,
        env: {
          ...env,
          ORCA_BACKGROUND_LAUNCH: '1',
          HOME: home,
          USERPROFILE: home,
          XDG_CONFIG_HOME: join(home, 'config'),
          XDG_DATA_HOME: join(home, 'data'),
          XDG_CACHE_HOME: join(home, 'cache'),
          XDG_STATE_HOME: join(home, 'state'),
          CLAUDE_CONFIG_DIR: join(home, 'claude'),
          CODEX_HOME: join(home, 'codex'),
          ORCA_E2E_USER_DATA_DIR: join(root, 'profile'),
          ORCA_E2E_HOME_DIR: home,
          ORCA_DISABLE_MACOS_LOGIN_SHELL: '1'
        }
      })
      writeFileSync(join(root, `${mode}.log`), `${result.stdout}\n${result.stderr}`)
      const raw = existsSync(join(root, `${mode}.json`))
        ? readFileSync(join(root, `${mode}.json`), 'utf8')
        : 'missing result'
      expect(result.error, raw).toBeUndefined()
      expect(result.status, `${raw}\n${result.stderr}`).toBe(0)
      console.log(`E1_${mode.toUpperCase()}`, raw)
    }
    const live = JSON.parse(readFileSync(join(root, 'live.json'), 'utf8'))
    const replay = JSON.parse(readFileSync(join(root, 'replay.json'), 'utf8'))
    expect(live.pending.pendingCookieImports['persist:e1-replay'].format).toBe('scoped-v1')
    expect(replay.pending.pendingCookieImports).toEqual({})
    for (const name of ['plain-valid', 'empty-host-hash']) {
      expect(live.rows.find((r: { name: string }) => r.name === name)).toMatchObject({
        present: true,
        secure: true,
        sent: true
      })
      expect(replay.rows.find((r: { name: string }) => r.name === name)).toMatchObject({
        present: true,
        secure: true,
        sent: true
      })
    }
    expect(live.rows.find((r: { name: string }) => r.name === 'none-insecure').present).toBe(false)
    for (const row of replay.rows) {
      const before = live.rows.find((r: { name: string }) => r.name === row.name)
      console.log(
        'E1_SHAPE',
        JSON.stringify({
          name: row.name,
          liveRejected: !before.present,
          replayPresent: row.present,
          replaySent: row.sent,
          replayValue: row.value,
          sentValue: row.sentValue
        })
      )
    }
  }, 240000)
})
