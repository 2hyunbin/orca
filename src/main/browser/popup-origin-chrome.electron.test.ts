import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  buildPopupIdentityProbe,
  createPopupIdentityProbeRoot,
  launchPopupIdentityProbe
} from './popup-identity-electron-probe'
import { startHiddenRendererFrameCapture } from './hidden-renderer-frame-capture-fixture'

type Snapshot = {
  id: number
  error?: string
  electron: string
  title?: string
  committedUrl?: string
  committedOrigin?: string
  windowsHidden: boolean
  bar: { label: string; insecure: boolean } | null
}
const held: ServerResponse[] = []
const requestedPaths: string[] = []
const root = createPopupIdentityProbeRoot()
const server = createServer((request, response) => {
  requestedPaths.push(request.url ?? '')
  if (request.url?.startsWith('/hold')) {
    held.push(response)
    return
  }
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/hold-redirect' }).end()
    return
  }
  if (request.url === '/failure') {
    response.destroy()
    return
  }
  response
    .writeHead(200, { 'content-type': 'text/html' })
    .end('<title>Page controlled title</title><p>Committed document</p>')
})
let origin: string
let probe: Awaited<ReturnType<typeof launchPopupIdentityProbe>>
let page: Page
let id = 0
const observations: Snapshot[] = []
let stopCapture: (() => Promise<void>) | undefined

async function command(
  action: string,
  options: { url?: string; kind?: string; stage?: string } = {}
): Promise<Snapshot> {
  const commandId = ++id
  await page.evaluate((input) => console.log(`origin-probe:${JSON.stringify(input)}`), {
    id: commandId,
    action,
    ...options
  })
  const path = join(root, 'status.json')
  await expect
    .poll(
      () => {
        if (!existsSync(path)) {
          return false
        }
        const result = JSON.parse(readFileSync(path, 'utf8'))
        if (result.error) {
          throw new Error(result.error)
        }
        return result.id
      },
      { timeout: 10_000 }
    )
    .toBe(commandId)
  const result: Snapshot = JSON.parse(readFileSync(path, 'utf8'))
  observations.push(result)
  return result
}

async function expectOrigin(label: string, kind: string): Promise<Snapshot> {
  let snapshot: Snapshot | undefined
  await expect
    .poll(
      async () => {
        snapshot = await command('snapshot')
        return kind === 'native' ? snapshot.title : snapshot.bar?.label
      },
      { timeout: 10_000 }
    )
    .toBe(label)
  if (!snapshot) {
    throw new Error('Missing snapshot')
  }
  expect(snapshot.windowsHidden).toBe(true)
  return snapshot
}

async function captureBar(stage: string): Promise<void> {
  if (process.env.ORCA_POPUP_IDENTITY_ARTIFACT_DIR) {
    await command('capture', { stage })
  }
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Missing HTTP port')
  }
  origin = `http://127.0.0.1:${address.port}`
  await buildPopupIdentityProbe(
    root,
    join(process.cwd(), 'src/main/browser/popup-origin-chrome-electron-fixture.ts'),
    'main.cjs'
  )
  probe = await launchPopupIdentityProbe(root)
  await vi.waitFor(
    () =>
      expect(
        probe.browser
          .contexts()
          .flatMap((context) => context.pages())
          .some((candidate) => candidate.url().startsWith('data:text/html,'))
      ).toBe(true),
    { timeout: 10_000 }
  )
  const found = probe.browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url().startsWith('data:text/html,'))
  if (!found) {
    throw new Error('Missing parent renderer')
  }
  page = found
  stopCapture = await startHiddenRendererFrameCapture(page, (hasFrame) =>
    vi.waitFor(() => expect(hasFrame()).toBe(true), { timeout: 10_000 })
  )
}, 60_000)

afterAll(async () => {
  for (const response of held) {
    response.destroy()
  }
  const artifacts = process.env.ORCA_POPUP_IDENTITY_ARTIFACT_DIR
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true })
    writeFileSync(
      join(artifacts, 'origin-observations.json'),
      JSON.stringify(observations, null, 2)
    )
  }
  await stopCapture?.()
  await probe?.stop()
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('committed popup origin chrome under Electron', () => {
  it.each(['adopted', 'native'])(
    'keeps %s chrome neutral for written blank content and retained through pending, canceled and failed redirects',
    async (kind) => {
      await command('kind', { kind })
      await page.evaluate((url) => {
        const child = window.open('about:blank', '', 'width=600,height=400')
        if (child) {
          Reflect.set(window, 'originProbeChild', child)
        }
        if (!child) {
          throw new Error('No child handle')
        }
        child.document.write('<title>https://requested.invalid</title><p>Written by opener</p>')
        child.location.href = url
      }, `${origin}/hold-initial`)
      const initial = await expectOrigin('about:blank', kind)
      expect(initial.committedUrl).toBe('about:blank')
      expect(initial.bar?.insecure ?? false).toBe(false)
      if (kind === 'adopted') {
        await captureBar('pending')
      }
      await command('stop')
      await expectOrigin('about:blank', kind)
      await command('block')
      await page.evaluate((url) => {
        Reflect.get(window, 'originProbeChild').location.href = url
      }, `${origin}/blocked`)
      await expectOrigin('about:blank', kind)
      expect(requestedPaths).not.toContain('/blocked')
      await command('navigate', { url: `${origin}/committed` })
      await expectOrigin(origin, kind)
      const otherOrigin = origin.replace('127.0.0.1', 'localhost')
      await command('navigate', { url: `${otherOrigin}/redirect` })
      await expectOrigin(origin, kind)
      await command('stop')
      await expectOrigin(origin, kind)
      await command('navigate', { url: `${otherOrigin}/committed` })
      await expectOrigin(otherOrigin, kind)
      if (kind === 'adopted') {
        await captureBar('committed')
      }
      await command('navigate', { url: `${otherOrigin}/failure` })
      await expect
        .poll(async () => (await command('snapshot')).committedUrl, { timeout: 10_000 })
        .not.toBe(`${otherOrigin}/committed`)
      const failure = await expectOrigin('unknown', kind)
      expect(failure.committedOrigin).toBe('null')
      const httpsFailure = `${origin.replace('http://127.0.0.1', 'https://popup-error.invalid')}/tls-failure`
      await command('navigate', { url: `${origin}/recovered` })
      await expectOrigin(origin, kind)
      await command('navigate', { url: httpsFailure })
      const opaque = await expectOrigin('unknown', kind)
      expect(opaque.committedUrl).toBe(httpsFailure)
      expect(opaque.committedOrigin).toBe('null')
      expect(opaque.bar?.insecure ?? true).toBe(true)
      if (kind === 'adopted') {
        await captureBar('opaque-error')
      }
      await command('close')
    },
    30_000
  )

  it.each(['adopted', 'native'])(
    'initializes a %s presenter from an already committed frame',
    async (kind) => {
      await command('attach', { kind, url: `${origin}/already-committed` })
      await expectOrigin(origin, kind)
      await command('close')
    }
  )
})
