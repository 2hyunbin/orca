import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { z } from 'zod'
import { expect, it } from 'vitest'

const fixtureResult = z.object({
  before: z.array(
    z.object({
      name: z.string(),
      domain: z.string(),
      path: z.string(),
      partitionKey: z
        .object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean() })
        .optional()
    })
  ),
  first: z.string(),
  second: z.string(),
  after: z.array(z.object({ name: z.string(), domain: z.string() })),
  opaque: z.literal('unverified: CDP cannot seed an opaque partition key')
})

it('clears all Google partitions and paths, preserves other sites, and repeats in real Electron', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-google-cookie-clear-'))
  try {
    const mainPath = join(root, 'main.cjs')
    const resultPath = join(root, 'result.json')
    const entry = `
      import { app, BrowserWindow, session } from 'electron'
      import { writeFileSync } from 'node:fs'
      import { clearGoogleCookiesFromPartition } from ${JSON.stringify(join(process.cwd(), 'src/main/browser/cookies/browser-google-cookie-clear.ts'))}
      app.setPath('userData', ${JSON.stringify(join(root, 'user-data'))})
      const deadline = setTimeout(() => app.exit(2), 30000)
      async function run() {
        await app.whenReady()
        const partition = 'persist:google-clear-fixture'
        const jar = session.fromPartition(partition)
        const window = new BrowserWindow({ show: false, webPreferences: { partition } })
        await window.loadURL('data:text/html,<title>Google cookie clear fixture</title>')
        const debug = window.webContents.debugger
        debug.attach('1.3')
        const set = async (cookie) => {
          const result = await debug.sendCommand('Network.setCookie', {
            secure: true, sameSite: 'None', value: 'fixture', ...cookie
          })
          if (!result.success) throw new Error('Cookie seeding failed: ' + cookie.name)
        }
        await set({ url: 'https://accounts.google.com/', name: 'twins' })
        for (const hasCrossSiteAncestor of [false, true]) {
          await set({ url: 'https://accounts.google.com/', name: 'twins',
            partitionKey: { topLevelSite: 'https://example.com', hasCrossSiteAncestor } })
        }
        await set({ url: 'https://google.com/', domain: '.google.com', name: 'domain' })
        await set({ url: 'https://google.com/', name: 'host-only' })
        for (const path of ['/one', '/two']) {
          await set({ url: 'https://google.com' + path, path, name: 'paths' })
        }
        await set({ url: 'https://example.com/', name: 'other' })
        await set({ url: 'https://youtube.com/', name: 'youtube' })
        await set({ url: 'https://google.com.evil.example/', name: 'suffix-trap' })
        await set({ url: 'https://example.com/', name: 'other-under-google',
          partitionKey: { topLevelSite: 'https://google.com', hasCrossSiteAncestor: true } })
        const before = (await debug.sendCommand('Network.getAllCookies')).cookies
        const first = await clearGoogleCookiesFromPartition(partition)
        const after = (await debug.sendCommand('Network.getAllCookies')).cookies
        const second = await clearGoogleCookiesFromPartition(partition)
        writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ before, first, second, after,
          opaque: 'unverified: CDP cannot seed an opaque partition key' }))
        debug.detach()
        window.destroy()
        clearTimeout(deadline)
        app.exit(0)
      }
      run().catch((error) => {
        writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ error: String(error?.stack || error) }))
        app.exit(1)
      })
    `
    await build({
      stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' },
      outfile: mainPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      external: ['electron']
    })
    writeFileSync(join(root, 'fixture-source.txt'), entry)
    const electronBinary: unknown = createRequire(import.meta.url)('electron')
    if (typeof electronBinary !== 'string') {
      throw new Error('Electron binary path unavailable')
    }
    const { ELECTRON_RUN_AS_NODE: _runAsNode, ...inherited } = process.env
    const env = {
      ...inherited,
      ORCA_BACKGROUND_LAUNCH: '1',
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: root,
      XDG_DATA_HOME: root,
      XDG_CACHE_HOME: root,
      XDG_STATE_HOME: root,
      CLAUDE_CONFIG_DIR: join(root, 'claude'),
      CODEX_HOME: join(root, 'codex'),
      ORCA_E2E_USER_DATA_DIR: join(root, 'user-data'),
      ORCA_E2E_HOME_DIR: root,
      ORCA_DISABLE_MACOS_LOGIN_SHELL: '1'
    }
    const args = [mainPath, '--password-store=basic', '--use-mock-keychain']
    const run = spawnSync(
      process.platform === 'linux' ? 'xvfb-run' : electronBinary,
      process.platform === 'linux'
        ? ['--auto-servernum', electronBinary, ...args, '--no-sandbox']
        : args,
      { env, encoding: 'utf8', timeout: 45000 }
    )
    expect(run.error).toBeUndefined()
    const raw = readFileSync(resultPath, 'utf8')
    expect(run.status, `${raw}\n${run.stderr}`).toBe(0)
    const result = fixtureResult.parse(JSON.parse(raw))
    expect(result.before.filter((cookie) => cookie.name === 'twins')).toHaveLength(3)
    expect(
      result.before
        .filter((cookie) => cookie.name === 'twins' && cookie.partitionKey)
        .map((cookie) => cookie.partitionKey?.hasCrossSiteAncestor)
        .sort()
    ).toEqual([false, true])
    expect(
      result.before
        .filter((cookie) => cookie.name === 'paths')
        .map((cookie) => cookie.path)
        .sort()
    ).toEqual(['/one', '/two'])
    expect(result.before).toHaveLength(11)
    expect(result.first).toBe('cleared')
    expect(result.second).toBe('empty')
    expect(result.after.map((cookie) => cookie.name).sort()).toEqual([
      'other',
      'other-under-google',
      'suffix-trap',
      'youtube'
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 90000)
