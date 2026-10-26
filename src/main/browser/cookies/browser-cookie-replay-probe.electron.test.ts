import { spawnSync } from 'node:child_process'
import { createCipheriv, createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { build } from 'vite'
import { createWorkspaceSourceResolver } from '../../../../config/scripts/workspace-source-exports.mjs'
import { createChromiumCookieTestDatabase } from './browser-cookie-import-test-database'

const partitionKey = { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }
const shapes = [
  { name: 'high-byte', value: '\u0080\u00a3\u00e9\u00ff' },
  { name: 'none-insecure', value: 'none', isSecure: 0 as const, sameSite: 0 as const },
  { name: 'control-chars', value: 'before\u0001\u0009\u000a\u000d\u007fafter' },
  { name: 'oversized', value: 'x'.repeat(4096) },
  { name: 'empty-host-hash', value: '' },
  { name: 'plain-valid', value: 'synthetic-valid' },
  {
    name: 'chips-high-byte',
    value: '\u0080\u00a3\u00e9\u00ff',
    topFrameSiteKey: partitionKey.topLevelSite,
    hasCrossSiteAncestor: 1 as const,
    sameSite: 0 as const
  },
  {
    name: 'chips-plain-valid',
    value: 'synthetic-chips-valid',
    topFrameSiteKey: partitionKey.topLevelSite,
    hasCrossSiteAncestor: 1 as const,
    sameSite: 0 as const
  }
]

type ReceivedValue = { value: string; hex: string; exact: boolean }
type ProbeRow = {
  name: string
  expectedHex: string
  present: boolean
  secure?: boolean
  jarValue?: string
  cdpCookies: { value: string; secure: boolean; partitionKey?: typeof partitionKey }[]
  unpartitionedTwin: boolean
  contexts: Record<string, ReceivedValue[]>
}
type WriteAttempt = {
  name: string
  success?: boolean
  error?: string
  partitionKey?: typeof partitionKey
}
type ProbeResult = {
  mode: string
  profile: string
  appPaths: { userData: string; sessionData: string; storage: string }
  stageOrigin?: string
  versions: Record<string, string>
  beforeCookies: unknown[]
  importResult?: { ok: boolean; summary: Record<string, unknown> }
  rows: ProbeRow[]
  writerAttempts: WriteAttempt[]
  pending: { pendingCookieImports: Record<string, { format: string; path: string }> }
  stageBefore: { path: string; exists: boolean }[]
  stageAfter: { path: string; exists: boolean; consumedExists: boolean }[]
  replayDatabaseExisted: boolean
  requests: {
    context: string
    host: string
    pairs: { name: string; value: string; hex: string }[]
  }[]
}

function fixture(bundle: string, root: string, scenarioShapes: typeof shapes): string {
  return String.raw`
const { app, BrowserWindow, session } = require('electron')
const { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { createHash, X509Certificate } = require('node:crypto')
const { join } = require('node:path')
const { createServer } = require('node:http')
const { createServer: createHttpsServer } = require('node:https')
const api = require(${JSON.stringify(bundle)})
const root = ${JSON.stringify(root)}
const mode = process.argv.find(v => v.startsWith('--probe-mode=')).split('=')[1]
const partition = 'persist:e1-replay'
const profile = join(root, 'profile-' + mode)
const metadata = { resolveMetadataPath: () => join(root, 'metadata.json'), defaultPartition: partition }
const resultPath = join(root, mode + '.json')
const shapes = ${JSON.stringify(scenarioShapes)}
const writerAttempts = []
const requests = []
const certificateChecks = []
const trustedCertificate = new X509Certificate(readFileSync(join(root, 'cert.pem'))).fingerprint256
mkdirSync(profile, { recursive: true })
app.setPath('userData', profile)
app.setPath('sessionData', profile)
app.on('window-all-closed', () => {})
writeFileSync(join(root, mode + '-identity.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), profile, home: process.env.HOME, argv: process.argv }))
// Observe native CDP replies without changing the writer, parameters, or rejection behavior.
app.on('web-contents-created', (_event, contents) => {
  const debug = contents.debugger
  const sendCommand = debug.sendCommand.bind(debug)
  debug.sendCommand = async (method, params, ...rest) => {
    const attempt = method === 'Network.setCookie' && shapes.some(s => s.name === params?.name)
      ? { name: params.name, partitionKey: params.partitionKey, requestedLatin1Hex: Buffer.from(params.value, 'latin1').toString('hex'), requestedUtf8Hex: Buffer.from(params.value, 'utf8').toString('hex') }
      : null
    try {
      const reply = await sendCommand(method, params, ...rest)
      if (attempt) Object.assign(attempt, { success: reply?.success !== false, reply })
      return reply
    } catch (error) {
      if (attempt) Object.assign(attempt, { success: false, error: String(error) })
      throw error
    } finally {
      if (attempt) {
        writerAttempts.push(attempt)
        writeFileSync(join(root, mode + '-native-writes.json'), JSON.stringify(writerAttempts, null, 2))
      }
    }
  }
})
const pendingMetadata = () => existsSync(metadata.resolveMetadataPath()) ? JSON.parse(readFileSync(metadata.resolveMetadataPath(), 'utf8')) : null
async function run() {
  const timer = setTimeout(() => { writeFileSync(resultPath, JSON.stringify({ error: 'E1 fixture timeout' })); app.exit(1) }, 60000)
  await app.whenReady()
  const stageBefore = Object.values(pendingMetadata()?.pendingCookieImports || {}).map(entry => ({ path: entry.path, exists: existsSync(entry.path) }))
  const replayDatabaseExisted = existsSync(join(profile, 'Partitions', 'e1-replay', 'Cookies')) || existsSync(join(profile, 'Partitions', 'e1-replay', 'Network', 'Cookies'))
  if (mode === 'replay') api.applyPendingBrowserCookieImports({ ...metadata, activeOrcaProfileId: 'e1' })
  const stageAfter = stageBefore.map(entry => ({ path: entry.path, exists: existsSync(entry.path), consumedExists: existsSync(entry.path + '.consumed') }))
  if (mode === 'replay') {
    const replayPath = join(profile, 'Partitions', 'e1-replay', 'Cookies')
    const database = new (require('node:sqlite').DatabaseSync)(replayPath, { readOnly: true })
    const rows = database.prepare('SELECT name, hex(value) AS valueHex, top_frame_site_key, has_cross_site_ancestor FROM cookies').all()
    database.close()
    writeFileSync(join(root, 'consumer-before-session.json'), JSON.stringify({ path: replayPath, rows }, null, 2))
  }
  const appPaths = { userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }
  const target = session.fromPartition(partition)
  appPaths.storage = target.getStoragePath()
  await target.setProxy({ mode: 'direct' })
  target.setCertificateVerifyProc((request, callback) => {
    const trusted = ['127.0.0.1', 'top.example', 'other.example'].includes(request.hostname) && new X509Certificate(request.certificate.data).fingerprint256 === trustedCertificate
    certificateChecks.push({ hostname: request.hostname, trusted })
    callback(trusted ? 0 : -3)
  })
  const window = new BrowserWindow({ show: false, webPreferences: { partition } })
  await window.loadURL('data:text/html,<title>E1 synthetic fixture</title>')
  const debug = window.webContents.debugger
  debug.attach('1.3')
  const beforeCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  debug.detach()
  let importResult
  let stageOrigin
  if (mode === 'live') {
    globalThis.e1SetPending = (p, path) => api.setPendingBrowserCookieImport({ ...metadata, partition: p, stagingDbPath: path })
    globalThis.e1ClearPending = (p) => {
      api.clearPendingBrowserCookieImport({ ...metadata, partition: p })
      const stagingDir = join(profile, 'cookie-import-staging')
      const stage = readdirSync(stagingDir).find(name => name.startsWith('Cookies-') && !name.endsWith('-wal') && !name.endsWith('-shm'))
      if (stage) {
        const original = join(stagingDir, stage)
        const captured = join(root, 'captured-stage.sqlite')
        copyFileSync(original, captured)
        const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
        writeFileSync(join(root, 'stage-capture.json'), JSON.stringify({ original, captured, originalSha256: sha256(original), capturedSha256: sha256(captured) }, null, 2))
      }
    }
    importResult = await api.importCookiesFromBrowser({ family: 'chrome', label: 'E1 synthetic Chromium', cookiesPath: join(root, 'source.db'), profiles: [], selectedProfile: '' }, partition)
    if (!importResult.ok) throw new Error(JSON.stringify(importResult))
    if (pendingMetadata()?.pendingCookieImports[partition]) {
      stageOrigin = 'native-pending'
    } else {
      const captured = join(root, 'captured-stage.sqlite')
      if (!existsSync(captured)) throw new Error('Native staging unavailable; cannot measure replay')
      api.setPendingBrowserCookieImport({ ...metadata, partition, stagingDbPath: captured })
      stageOrigin = 'captured-before-native-cleanup'
    }
  }
  const cookies = await target.cookies.get({})
  debug.attach('1.3')
  const cdpCookies = (await debug.sendCommand('Network.getAllCookies')).cookies
  let cookieLoadProblems
  try { cookieLoadProblems = await debug.sendCommand('Browser.getHistograms', { query: 'Cookie.LoadProblem', delta: false }) }
  catch (error) { cookieLoadProblems = { unavailable: String(error) } }
  const httpsPort = Number(process.env.E1_PROBE_PORT || 9480) + 1
  const handle = (req, res) => {
    const url = new URL(req.url, 'https://' + req.headers.host)
    const context = url.searchParams.get('context')
    res.setHeader('Cache-Control', 'no-store')
    if (url.pathname === '/outer') {
      res.end('<title>E1 outer</title><iframe src="https://127.0.0.1:' + httpsPort + '/echo?context=' + context + '"></iframe>')
      return
    }
    if (url.pathname === '/echo') {
      const header = req.headers.cookie || ''
      const pairs = header.split(';').flatMap(token => {
        const pair = token.startsWith(' ') ? token.slice(1) : token
        const i = pair.indexOf('=')
        return i < 1 ? [] : [{ name: pair.slice(0, i), value: pair.slice(i + 1), hex: Buffer.from(pair.slice(i + 1), 'latin1').toString('hex') }]
      })
      requests.push({ context, host: req.headers.host, header, headerHex: Buffer.from(header, 'latin1').toString('hex'), rawHeaders: req.rawHeaders, pairs })
      writeFileSync(join(root, mode + '-headers.json'), JSON.stringify(requests, null, 2))
    }
    res.end('<title>E1 received</title>')
  }
  const server = createServer(handle)
  const httpsServer = createHttpsServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, handle)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.E1_PROBE_PORT || 9480), '127.0.0.1', resolve) })
  await new Promise((resolve, reject) => { httpsServer.once('error', reject); httpsServer.listen(httpsPort, '127.0.0.1', resolve) })
  const urls = {
    http: 'http://127.0.0.1:' + server.address().port + '/echo?context=http',
    matching: 'https://top.example:' + httpsPort + '/outer?context=matching',
    wrongTop: 'https://other.example:' + httpsPort + '/outer?context=wrongTop',
    standalone: 'https://127.0.0.1:' + httpsPort + '/echo?context=standalone'
  }
  const securityContexts = {}
  for (const [context, url] of Object.entries(urls)) {
    await window.loadURL(url)
    securityContexts[context] = await window.webContents.executeJavaScript('JSON.stringify({ origin: location.origin, secure: isSecureContext, frames: frames.length })')
    if (!requests.some(request => request.context === context)) throw new Error('Missing server receipt for ' + context)
  }
  const rows = shapes.map(shape => {
    const cookie = cookies.find(c => c.name === shape.name)
    const identities = cdpCookies.filter(c => c.name === shape.name)
    const expectedHex = Buffer.from(shape.value, 'latin1').toString('hex')
    const contexts = Object.fromEntries(Object.keys(urls).map(context => [context, requests.filter(request => request.context === context).flatMap(request => request.pairs.filter(pair => pair.name === shape.name).map(pair => ({ value: pair.value, hex: pair.hex, exact: pair.hex === expectedHex })))]))
    return { name: shape.name, expectedHex, present: !!cookie, jarValue: cookie?.value, secure: cookie?.secure, cdpCookies: identities, unpartitionedTwin: !!shape.topFrameSiteKey && identities.some(c => !c.partitionKey), contexts }
  })
  const pending = pendingMetadata()
  const capturePath = join(root, 'stage-capture.json')
  const stageCapture = existsSync(capturePath) ? JSON.parse(readFileSync(capturePath, 'utf8')) : null
  if (stageCapture) stageCapture.originalExistsAfterImport = existsSync(stageCapture.original)
  writeFileSync(resultPath, JSON.stringify({ mode, profile, appPaths, versions: process.versions, platform: process.platform, release: require('node:os').release(), beforeCookies, importResult, stageOrigin, stageCapture, cookieLoadProblems, rows, writerAttempts, requests, pending, stageBefore, stageAfter, replayDatabaseExisted, certificateChecks, securityContexts }, null, 2))
  debug.detach()
  await target.cookies.flushStore()
  await new Promise(resolve => server.close(resolve))
  await new Promise(resolve => httpsServer.close(resolve))
  window.destroy()
  clearTimeout(timer)
  app.quit()
}
run().catch(error => { writeFileSync(resultPath, JSON.stringify({ error: String(error.stack || error), writerAttempts, requests, certificateChecks })); app.exit(1) })
`
}

function compactValues(values: ReceivedValue[]) {
  return values.map(({ hex, exact }) => ({
    ...(hex.length <= 128 ? { hex } : { bytes: hex.length / 2 }),
    exact
  }))
}

describe('E1 native Chromium live import versus cold-start staged replay', () => {
  it.each(['mixed', 'valid-only', ...shapes.map((shape) => shape.name)])(
    '%s: measures isolated replay, CHIPS contexts, and valid siblings',
    async (scenario) => {
      const controls = ['plain-valid', 'empty-host-hash', 'chips-plain-valid']
      const scenarioShapes = shapes.filter(
        (shape) => scenario === 'mixed' || controls.includes(shape.name) || shape.name === scenario
      )
      const root = mkdtempSync(join(tmpdir(), 'orca-e1-replay-'))
      console.log('E1_EVIDENCE_ROOT', JSON.stringify({ scenario, root }))
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
        scenarioShapes.map((s) => ({
          ...s,
          domain: '127.0.0.1',
          isSecure: s.isSecure ?? 1,
          encryptedValue: s.name === 'empty-host-hash' ? encryptedEmpty : undefined
        }))
      )
      for (const shape of scenarioShapes.filter((s) => s.name.includes('high-byte'))) {
        source
          .prepare('UPDATE cookies SET value = ? WHERE name = ?')
          .run(Buffer.from(shape.value, 'latin1'), shape.name)
      }
      source.exec(
        'ALTER TABLE cookies ADD COLUMN has_expires INTEGER NOT NULL DEFAULT 1; ALTER TABLE cookies ADD COLUMN is_persistent INTEGER NOT NULL DEFAULT 1'
      )
      source
        .prepare('UPDATE cookies SET expires_utc = ?')
        .run(BigInt(Date.now() + 86400000) * 1000n + 11644473600000000n)
      source.close()
      writeFileSync(
        join(root, 'expected-values.json'),
        JSON.stringify(
          scenarioShapes.map((s) => ({
            name: s.name,
            hex: Buffer.from(s.value, 'latin1').toString('hex'),
            partitionKey: s.topFrameSiteKey ? partitionKey : null
          })),
          null,
          2
        )
      )
      const certResult = spawnSync(
        'openssl',
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '2',
          '-subj',
          '/CN=E1 synthetic fixture',
          '-addext',
          'subjectAltName=DNS:top.example,DNS:other.example,IP:127.0.0.1',
          '-keyout',
          join(root, 'key.pem'),
          '-out',
          join(root, 'cert.pem')
        ],
        { encoding: 'utf8' }
      )
      writeFileSync(
        join(root, 'certificate-generation.log'),
        `${certResult.stdout}\n${certResult.stderr}`
      )
      expect(certResult.status, certResult.stderr).toBe(0)
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
        resolve: {
          alias: [
            { find: /^.*\/browser-session-registry(?:\.ts)?$/, replacement: registry },
            { find: /^.*\/browser-cookie-key(?:\.ts)?$/, replacement: keyModule },
            ...createWorkspaceSourceResolver().aliases
          ]
        },
        build: {
          emptyOutDir: false,
          minify: false,
          lib: { entry, formats: ['cjs'], fileName: () => 'import.cjs' },
          outDir: root,
          target: 'node20',
          rollupOptions: { external: ['electron', /^node:/] }
        }
      })
      const main = join(root, 'main.cjs')
      writeFileSync(main, fixture(bundle, root, scenarioShapes))
      const { ELECTRON_RUN_AS_NODE: _runAsNode, NODE_OPTIONS: _nodeOptions, ...env } = process.env
      const electron = createRequire(import.meta.url)('electron')
      for (const mode of ['live', 'replay']) {
        const home = join(root, `home-${mode}`)
        mkdirSync(home)
        const result = spawnSync(
          electron,
          [
            main,
            `--probe-mode=${mode}`,
            `--user-data-dir=${join(root, `profile-${mode}`)}`,
            `--log-net-log=${join(root, `${mode}-netlog.json`)}`,
            '--net-log-capture-mode=Everything',
            '--password-store=basic',
            '--use-mock-keychain',
            '--no-proxy-server',
            '--host-resolver-rules=MAP top.example 127.0.0.1, MAP other.example 127.0.0.1'
          ],
          {
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
              ORCA_E2E_USER_DATA_DIR: join(root, `profile-${mode}`),
              ORCA_E2E_HOME_DIR: home,
              ORCA_DISABLE_MACOS_LOGIN_SHELL: '1'
            }
          }
        )
        writeFileSync(join(root, `${mode}.log`), `${result.stdout}\n${result.stderr}`)
        const raw = existsSync(join(root, `${mode}.json`))
          ? readFileSync(join(root, `${mode}.json`), 'utf8')
          : 'missing result'
        expect(result.error, raw).toBeUndefined()
        expect(result.status, `${raw}\n${result.stderr}`).toBe(0)
        if (mode === 'live') {
          const live: ProbeResult = JSON.parse(raw)
          const stagedPath = live.pending?.pendingCookieImports['persist:e1-replay']?.path
          expect(stagedPath, 'Native importer must leave an authentic scoped stage').toBeTruthy()
          copyFileSync(stagedPath, join(root, 'authentic-stage-before-replay.sqlite'))
          const database = new DatabaseSync(stagedPath, { readOnly: true })
          const stagedRows = database
            .prepare(
              'SELECT name, hex(value) AS valueHex, top_frame_site_key, has_cross_site_ancestor, is_secure, CAST(expires_utc AS TEXT) AS expires_utc FROM cookies ORDER BY rowid'
            )
            .all()
          const scope = database.prepare('SELECT * FROM orca_cookie_import_scope').all()
          database.close()
          writeFileSync(
            join(root, 'stage-before-replay.json'),
            JSON.stringify(
              {
                path: stagedPath,
                sha256: createHash('sha256').update(readFileSync(stagedPath)).digest('hex'),
                rows: stagedRows,
                scope
              },
              null,
              2
            )
          )
        }
      }
      const live: ProbeResult = JSON.parse(readFileSync(join(root, 'live.json'), 'utf8'))
      const replay: ProbeResult = JSON.parse(readFileSync(join(root, 'replay.json'), 'utf8'))
      const controlsPassed = [live, replay].every((arm) =>
        controls.every((name) => {
          const row = arm.rows.find((candidate) => candidate.name === name)
          const context = name.startsWith('chips-') ? 'matching' : 'http'
          return (
            row?.present &&
            row.secure &&
            row.contexts[context].length === 1 &&
            row.contexts[context][0].exact
          )
        })
      )
      for (const row of replay.rows) {
        const before = live.rows.find((r) => r.name === row.name)
        const write = live.writerAttempts.find((attempt) => attempt.name === row.name)
        const context = row.name.startsWith('chips-') ? 'matching' : 'http'
        console.log(
          'E1_SHAPE',
          JSON.stringify({
            scenario,
            controlsPassed,
            stageOrigin: live.stageOrigin,
            name: row.name,
            ...(row.expectedHex.length <= 128
              ? { expectedHex: row.expectedHex }
              : { expectedBytes: row.expectedHex.length / 2 }),
            writerRejected: write?.success === false,
            writerError:
              write?.error ??
              (write?.success === false ? 'Network.setCookie returned success:false' : undefined),
            liveRejected: !before?.present,
            liveSent: (before?.contexts[context].length ?? 0) > 0,
            liveValues: compactValues(before?.contexts[context] ?? []),
            replayPresent: row.present,
            replaySent: row.contexts[context].length > 0,
            replayValues: compactValues(row.contexts[context]),
            ...(row.name.startsWith('chips-')
              ? {
                  livePartitionKeys: before?.cdpCookies.map(
                    (cookie) => cookie.partitionKey ?? null
                  ),
                  replayPartitionKeys: row.cdpCookies.map((cookie) => cookie.partitionKey ?? null),
                  liveWrongTopSent: (before?.contexts.wrongTop.length ?? 0) > 0,
                  replayWrongTopSent: row.contexts.wrongTop.length > 0,
                  liveStandaloneSent: (before?.contexts.standalone.length ?? 0) > 0,
                  replayStandaloneSent: row.contexts.standalone.length > 0,
                  unpartitionedTwin: before?.unpartitionedTwin || row.unpartitionedTwin
                }
              : {})
          })
        )
      }
      expect(live.profile).not.toBe(replay.profile)
      expect(live.beforeCookies).toEqual([])
      expect(live.importResult?.summary).toMatchObject({
        totalCookies: scenarioShapes.length,
        importedCookies: scenarioShapes.length,
        skippedCookies: 0
      })
      const consumerSnapshot: { rows: { name: string }[] } = JSON.parse(
        readFileSync(join(root, 'consumer-before-session.json'), 'utf8')
      )
      expect(consumerSnapshot.rows.map((row) => row.name).sort()).toEqual(
        scenarioShapes.map((shape) => shape.name).sort()
      )
      expect(replay.replayDatabaseExisted).toBe(false)
      expect(live.writerAttempts.map((attempt) => attempt.name).sort()).toEqual(
        scenarioShapes.map((s) => s.name).sort()
      )
      expect(live.pending.pendingCookieImports['persist:e1-replay'].format).toBe('scoped-v1')
      expect(replay.stageBefore).toHaveLength(1)
      expect(replay.stageBefore[0].exists).toBe(true)
      expect(replay.stageBefore[0].path).toBe(
        live.pending.pendingCookieImports['persist:e1-replay'].path
      )
      expect(replay.stageAfter[0]).toMatchObject({ exists: false, consumedExists: false })
      expect(replay.pending.pendingCookieImports).toEqual({})
      for (const arm of [live, replay]) {
        expect(arm.appPaths).toEqual({
          userData: arm.profile,
          sessionData: arm.profile,
          storage: join(arm.profile, 'Partitions', 'e1-replay')
        })
        for (const row of arm.rows.filter((row) => row.present)) {
          expect(row.cdpCookies).toHaveLength(1)
        }
        for (const name of ['plain-valid', 'empty-host-hash']) {
          const row = arm.rows.find((r) => r.name === name)
          expect(row).toMatchObject({ present: true, secure: true })
          expect(row?.contexts.http).toEqual([expect.objectContaining({ exact: true })])
        }
        const plainChips = arm.rows.find((r) => r.name === 'chips-plain-valid')
        expect(plainChips?.contexts.matching).toEqual([expect.objectContaining({ exact: true })])
        for (const row of arm.rows.filter((r) => r.name.startsWith('chips-'))) {
          expect(row.unpartitionedTwin).toBe(false)
          for (const cookie of row.cdpCookies) {
            expect(cookie.partitionKey).toEqual(partitionKey)
          }
          expect(row.contexts.http).toEqual([])
          expect(row.contexts.wrongTop).toEqual([])
          expect(row.contexts.standalone).toEqual([])
        }
      }
      if (scenarioShapes.some((shape) => shape.name === 'none-insecure')) {
        expect(live.rows.find((r) => r.name === 'none-insecure')?.present).toBe(false)
      }
    },
    240000
  )
})
