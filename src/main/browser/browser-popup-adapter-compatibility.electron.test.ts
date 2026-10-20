import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import {
  browser,
  closeChildren,
  enablePopupAdapterProbe,
  expectedSecurity,
  guest,
  origin,
  receipts,
  setPopupFixtureEvidenceName,
  snapshots,
  status
} from './browser-popup-compatibility-cdp-fixture'
import { waitForHiddenFrameInput } from './hidden-frame-input-readiness-fixture'

enablePopupAdapterProbe()
setPopupFixtureEvidenceName('adapter-electron-evidence.json')

type CreationPath = 'adopted' | 'native'
const creationPaths = ['adopted', 'native'] as const

function eventsSince(offset: number): Record<string, unknown>[] {
  return status().adapterProbe?.slice(offset) ?? []
}

async function childAt(url: string): Promise<Page> {
  await expect
    .poll(() =>
      browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .some((candidate) => candidate.url() === url)
    )
    .toBe(true)
  const child = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url() === url)
  if (!child) {
    throw new Error('Missing probe child')
  }
  return child
}

async function configureProbe(page: Page, command: string): Promise<void> {
  const offset = status().adapterProbe?.length ?? 0
  const message = `orca-popup-fixture:probe-${command}`
  await page.evaluate((message) => console.log(message), message)
  await expect
    .poll(() =>
      eventsSince(offset).some(
        (event) => event.event === 'probe-configured' && event.message === message
      )
    )
    .toBe(true)
}

async function configure(page: Page, path: CreationPath): Promise<void> {
  await configureProbe(page, path)
}

async function installBurst(page: Page, count = 3): Promise<void> {
  await page.evaluate((count) => {
    document.querySelector('#identity-burst')?.remove()
    const button = document.createElement('button')
    button.id = 'identity-burst'
    button.onclick = () => {
      for (let index = 0; index < count; index++) {
        const child = window.open('/identical-child')
        if (child) {
          child.name = `original-request-${index}`
        }
      }
    }
    document.body.append(button)
  }, count)
}

function assertObservedCreationOrder(events: Record<string, unknown>[], path: CreationPath): void {
  const delivered = events.filter(
    (event) => event.event === (path === 'adopted' ? 'createWindow' : 'did-create-window')
  )
  const admitted = events.filter((event) => event.event === 'admission')
  expect(delivered.length).toBe(admitted.length)
  for (const [index, event] of delivered.entries()) {
    expect(event.owner).toBe(admitted[index].owner)
    expect(event.preferences).toMatchObject(expectedSecurity)
    if (path === 'adopted') {
      expect(event.callbackRequest).toBe(admitted[index].request)
    } else {
      expect(event.optionsArguments).toEqual([
        `--orca-popup-probe=${String(admitted[index].request)}`
      ])
    }
    const first = events.findIndex(
      (candidate) =>
        candidate.event === 'did-start-navigation' && candidate.contentsId === event.contentsId
    )
    expect(first).toBeGreaterThan(events.indexOf(event))
    expect(
      events.find(
        (candidate) =>
          candidate.event === 'before-request' && candidate.contentsId === event.contentsId
      )
    ).toMatchObject({ observedBeforeRequest: true, webRtcPolicy: 'disable_non_proxied_udp' })
  }
}

describe('Electron popup adapter API limits (not an admission safety gate)', () => {
  it.each(creationPaths)(
    'records same-parent identical URLs with foreground, background and window intent: %s',
    async (path) => {
      expect(status().electronVersion).toBe('43.7.8')
      const page = guest('probe-one')
      await configure(page, path)
      for (const modifier of [null, 'Shift', 'ControlOrMeta'] as const) {
        const offset = status().adapterProbe?.length ?? 0
        const before = receipts.length
        await installBurst(page)
        await page.locator('#identity-burst').click(modifier ? { modifiers: [modifier] } : {})
        await expect
          .poll(
            () =>
              receipts.slice(before).filter((receipt) => receipt.path === '/identical-child').length
          )
          .toBe(3)
        await expect
          .poll(() => eventsSince(offset).filter((event) => event.event === 'loaded').length)
          .toBe(3)
        const events = eventsSince(offset)
        assertObservedCreationOrder(events, path)
        expect(
          events
            .filter((event) => event.event === 'loaded')
            .map((event) => event.frameName)
            .sort()
        ).toEqual(['original-request-0', 'original-request-1', 'original-request-2'])
        const dispositions = events
          .filter((event) => event.event === 'admission')
          .map((event) => event.details)
        expect(dispositions).toEqual(
          Array.from({ length: 3 }, () =>
            expect.objectContaining({
              disposition:
                modifier === 'Shift' ? 'new-window' : modifier ? 'background-tab' : 'foreground-tab'
            })
          )
        )
        snapshots.push(status())
        await closeChildren(page)
      }
    }
  )

  it.each(creationPaths)(
    'records two parents sharing a session with distinct simultaneous intent: %s',
    async (path) => {
      const pages = [guest('probe-one'), guest('probe-two')]
      for (const page of pages) {
        await configure(page, path)
        await installBurst(page, 1)
      }
      const offset = status().adapterProbe?.length ?? 0
      const before = receipts.length
      await Promise.all([
        pages[0].locator('#identity-burst').click({ modifiers: ['Shift'] }),
        pages[1].locator('#identity-burst').click({ modifiers: ['ControlOrMeta'] })
      ])
      await expect
        .poll(
          () =>
            receipts.slice(before).filter((receipt) => receipt.path === '/identical-child').length
        )
        .toBe(2)
      await expect
        .poll(() => eventsSince(offset).filter((event) => event.event === 'loaded').length)
        .toBe(2)
      const events = eventsSince(offset)
      const admitted = events.filter((event) => event.event === 'admission')
      expect(new Set(admitted.map((event) => event.owner)).size).toBe(2)
      // Each parent's delivery is observed independently; ordering across parents is not authority.
      for (const owner of admitted.map((event) => event.owner)) {
        assertObservedCreationOrder(
          events.filter((event) => event.owner === owner || !event.owner),
          path
        )
      }
      expect(
        receipts
          .slice(before)
          .filter((receipt) => receipt.path === '/identical-child')
          .every((receipt) => receipt.cookie === 'synthetic_session=local')
      ).toBe(true)
      snapshots.push(status())
      for (const page of pages) {
        await closeChildren(page)
      }
    }
  )

  it.each(creationPaths)(
    'records immediate close, then reopen without inferring cancellation from delivery order: %s',
    async (path) => {
      const page = guest('probe-one')
      await configure(page, path)
      const offset = status().adapterProbe?.length ?? 0
      await page.evaluate(() => {
        document.querySelector('#cancel-probe')?.remove()
        const button = document.createElement('button')
        button.id = 'cancel-probe'
        button.onclick = () => {
          window.open('/cancelled-child')?.close()
          const child = window.open('/reopened-child')
          if (child) {
            child.name = 'reopened-original'
          }
        }
        document.body.append(button)
      })
      await page.locator('#cancel-probe').click({ modifiers: ['Shift'] })
      const reopened = await childAt(`${origin}/reopened-child`)
      expect(await reopened.evaluate('window.name')).toBe('reopened-original')
      const events = eventsSince(offset)
      expect(events.filter((event) => event.event === 'admission')).toHaveLength(2)
      expect(
        events.filter(
          (event) => event.event === (path === 'adopted' ? 'createWindow' : 'did-create-window')
        )
      ).toHaveLength(2)
      // Both creation callbacks precede the renderer's close(); this is not a missing-callback cancellation.
      snapshots.push(status())
      await closeChildren(page)
    }
  )

  it.each(creationPaths)(
    'cannot distinguish inherited script restrictions synchronously: %s',
    async (path) => {
      const records = await exerciseSandboxControls(path, 'script')
      expect(records[0].preferences).toEqual(records[1].preferences)
      expect(records[0].frameOrigin).toBe(records[1].frameOrigin)
      if (path === 'adopted') {
        expect(withoutRequestMarker(records[0].optionsPreferences)).toEqual(
          withoutRequestMarker(records[1].optionsPreferences)
        )
      }
    }
  )

  it.each(creationPaths)(
    'exposes inherited flags on native OpenURL link options only: %s',
    async (path) => {
      const records = await exerciseSandboxControls(path, 'link')
      const preferences = records.map((record) => record.optionsPreferences)
      expect(preferences[0]).toHaveProperty('openerSandboxFlags', expect.any(Number))
      expect(preferences[1]).not.toHaveProperty('openerSandboxFlags')
      expect(preferences[2]).not.toHaveProperty('openerSandboxFlags')
      if (path === 'adopted') {
        expect(records.every((record) => record.event === 'createWindow-missing')).toBe(true)
      }
    }
  )

  it('records baseline early tab dispatch for the restricted script with zero original-child requests', async () => {
    const page = guest('local')
    const before = receipts.length
    const tabs = status().tabOpens.length
    await installSandboxFrame(page, 'restricted', `${origin}/baseline-restricted`, 'script')
    await page.frameLocator('#sandbox-probe').locator('#open').click()
    await expect.poll(() => status().tabOpens.length).toBe(tabs + 1)
    expect(status().tabOpens.at(-1)).toEqual({
      url: `${origin}/baseline-restricted`,
      activate: true
    })
    expect(receipts.slice(before).some((receipt) => receipt.path === '/baseline-restricted')).toBe(
      false
    )
    snapshots.push(status())
  })

  it.each(['script', 'link'] as const)(
    'isolates same-session and foreign-session app windows during original %s creation',
    async (kind) => {
      const page = guest('probe-two')
      for (const foreign of [false, true]) {
        await configureProbe(page, foreign ? 'unrelated-foreign' : 'unrelated')
        await installBurst(page, 1)
        await page.evaluate(() => {
          document.querySelector('#native-isolation')?.remove()
          const link = document.createElement('a')
          link.id = 'native-isolation'
          link.href = '/isolation-original'
          link.textContent = 'Original native link'
          document.body.append(link)
        })
        const offset = status().adapterProbe?.length ?? 0
        await page
          .locator(kind === 'script' ? '#identity-burst' : '#native-isolation')
          .click({ modifiers: ['Shift'] })
        await expect
          .poll(() => eventsSince(offset).some((event) => event.event === 'did-create-window'))
          .toBe(true)
        const events = eventsSince(offset)
        const unrelated = events.find((event) => event.event === 'unrelated-window')
        const admitted = events.find((event) => event.event === 'production-adapter-created')
        expect(unrelated).toBeDefined()
        expect(admitted).toBeDefined()
        expect(admitted?.contentsId).not.toBe(unrelated?.contentsId)
        expect(events.some((event) => event.event === 'unrelated-destroyed')).toBe(false)
        expect(events.filter((event) => event.event === 'production-adapter-created')).toHaveLength(
          1
        )
        expect(events.find((event) => event.event === 'did-create-window')?.contentsId).toBe(
          admitted?.contentsId
        )
        snapshots.push(status())
        await configureProbe(page, 'cleanup')
        await closeChildren(page)
      }
    }
  )
  // Production keeps an admission guard on the opener, so raw API probes run first.
  it('correlates production scripted admissions for identical-URL children before navigation', async () => {
    const page = guest('probe-one')
    await configureProbe(page, 'production-scripted')
    const offset = status().adapterProbe?.length ?? 0
    const before = receipts.length
    await installBurst(page)
    await page.locator('#identity-burst').click({ modifiers: ['Shift'] })
    await expect
      .poll(() => eventsSince(offset).filter((event) => event.event === 'loaded').length)
      .toBe(3)
    const events = eventsSince(offset)
    const created = events.filter((event) => event.event === 'production-adapter-created')
    const delivered = events.filter((event) => event.event === 'did-create-window')
    expect(created).toHaveLength(3)
    expect(delivered).toHaveLength(3)
    for (const child of created) {
      const delivery = delivered.find((event) => event.contentsId === child.contentsId)
      expect(delivery?.owner).toBe(child.owner)
      expect(delivery?.optionsArguments).toEqual([`--orca-popup-probe=${String(child.request)}`])
      expect(child.preferences).toMatchObject(expectedSecurity)
      expect(
        events.findIndex(
          (event) =>
            event.event === 'browser-window-created' && event.contentsId === child.contentsId
        )
      ).toBeGreaterThan(events.indexOf(child))
      expect(
        events.findIndex(
          (event) => event.event === 'did-start-navigation' && event.contentsId === child.contentsId
        )
      ).toBeGreaterThan(events.indexOf(child))
    }
    expect(
      receipts.slice(before).filter((receipt) => receipt.path === '/identical-child')
    ).toHaveLength(3)
    const requests = events.filter((event) => event.event === 'admission')
    for (const [index, request] of requests.entries()) {
      const child = created.find((event) => event.request === request.request)
      const loaded = events.find(
        (event) => event.event === 'loaded' && event.contentsId === child?.contentsId
      )
      expect(loaded?.frameName).toBe(`original-request-${index}`)
    }
    expect(status().windowsHidden).toBe(true)
    snapshots.push(status())
    await closeChildren(page)
  })
  it('cancels a held original child before creation notification, then binds its successor independently', async () => {
    const page = guest('probe-one')
    await configureProbe(page, 'hold-delivery')
    const offset = status().adapterProbe?.length ?? 0
    const before = receipts.length
    await installBurst(page, 1)
    await page.locator('#identity-burst').click({ modifiers: ['Shift'] })
    await expect
      .poll(() => eventsSince(offset).some((event) => event.event === 'delivery-held'))
      .toBe(true)
    await configureProbe(page, 'cancel-held')
    await expect
      .poll(() => eventsSince(offset).some((event) => event.event === 'held-delivery-discarded'))
      .toBe(true)
    await installBurst(page, 1)
    await page.locator('#identity-burst').click({ modifiers: ['Shift'] })
    await expect
      .poll(() => eventsSince(offset).some((event) => event.event === 'loaded'))
      .toBe(true)
    const events = eventsSince(offset)
    const held = events.find((event) => event.event === 'delivery-held')
    const canceled = events.find((event) => event.event === 'held-original-canceled')
    expect(canceled).toMatchObject({
      contentsId: held?.contentsId,
      frameName: 'original-request-0'
    })
    const callbacks = events.filter((event) => event.event === 'production-adapter-created')
    expect(callbacks).toHaveLength(1)
    expect(callbacks[0].contentsId).not.toBe(held?.contentsId)
    expect(callbacks[0].request).toBe(
      events.filter((event) => event.event === 'admission')[1].request
    )
    expect(
      events.find(
        (event) => event.event === 'loaded' && event.contentsId === callbacks[0].contentsId
      )?.frameName
    ).toBe('original-request-0')
    expect(
      receipts.slice(before).filter((receipt) => receipt.path === '/identical-child')
    ).toHaveLength(1)
    expect(status().windowsHidden).toBe(true)
    snapshots.push(status())
    await closeChildren(page)
  })

  it('rejects a genuinely late live child whose navigation was held behind preparation', async () => {
    const page = guest('probe-one')
    await configureProbe(page, 'hold-delivery')
    const offset = status().adapterProbe?.length ?? 0
    const before = receipts.length
    await installBurst(page, 1)
    await page.locator('#identity-burst').click({ modifiers: ['Shift'] })
    await expect
      .poll(() => eventsSince(offset).some((event) => event.event === 'will-frame-navigate'))
      .toBe(true)
    await configureProbe(page, 'release-held')
    await expect
      .poll(() => eventsSince(offset).some((event) => event.event === 'did-create-window'))
      .toBe(true)
    const events = eventsSince(offset)
    const held = events.find((event) => event.event === 'delivery-held')
    expect(events.find((event) => event.event === 'held-original-released')).toMatchObject({
      contentsId: held?.contentsId,
      frameName: 'original-request-0'
    })
    expect(events.filter((event) => event.event === 'production-adapter-created')).toHaveLength(0)
    expect(
      events.filter(
        (event) => event.event === 'before-request' && event.contentsId === held?.contentsId
      )
    ).toHaveLength(0)
    expect(
      receipts.slice(before).filter((receipt) => receipt.path === '/identical-child')
    ).toHaveLength(0)
    expect(status().windowsHidden).toBe(true)
    snapshots.push(status())
  })

  it('fails closed at the actual engine boundary when a second request overlaps held delivery', async () => {
    const page = guest('probe-two')
    await configureProbe(page, 'production-scripted')
    await configureProbe(page, 'hold-delivery')
    const offset = status().adapterProbe?.length ?? 0
    const before = receipts.length
    await installBurst(page, 2)
    await page.locator('#identity-burst').click({ modifiers: ['Shift'] })
    await expect
      .poll(() => eventsSince(offset).some((event) => event.event === 'held-delivery-discarded'))
      .toBe(true)
    const events = eventsSince(offset)
    const held = events.find((event) => event.event === 'delivery-held')
    expect(
      events.find((event) => event.event === 'held-original-before-next-request')
    ).toMatchObject({ contentsId: held?.contentsId, frameName: 'original-request-0' })
    expect(
      events.filter((event) => event.event === 'production-response').map((event) => event.action)
    ).toEqual(['allow', 'deny'])
    expect(events.filter((event) => event.event === 'production-adapter-created')).toHaveLength(0)
    expect(events.filter((event) => event.event === 'did-create-window')).toHaveLength(0)
    expect(
      receipts.slice(before).filter((receipt) => receipt.path === '/identical-child')
    ).toHaveLength(0)
    expect(status().windowsHidden).toBe(true)
    snapshots.push(status())
    // Recovery follows the confirmed original destruction; the opener remains usable.
    await installBurst(page, 1)
    await page.locator('#identity-burst').click({ modifiers: ['Shift'] })
    await expect
      .poll(
        () =>
          eventsSince(offset).filter((event) => event.event === 'production-adapter-created').length
      )
      .toBe(1)
    await expect
      .poll(() => eventsSince(offset).filter((event) => event.event === 'loaded').length)
      .toBe(1)
    const recovered = eventsSince(offset).find(
      (event) => event.event === 'production-adapter-created'
    )
    expect(recovered?.contentsId).not.toBe(held?.contentsId)
    expect(recovered?.request).toBe(
      eventsSince(offset).filter((event) => event.event === 'admission')[2]?.request
    )
    snapshots.push(status())
    await closeChildren(page)
  })
})

function withoutRequestMarker(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !['additionalArguments', 'session'].includes(key))
  )
}

async function installSandboxFrame(
  page: Page,
  sandbox: string,
  destination: string,
  kind: string
): Promise<void> {
  await page.evaluate(
    ({ sandbox, destination, kind }) => {
      document.querySelector('#sandbox-probe')?.remove()
      const frame = document.createElement('iframe')
      frame.id = 'sandbox-probe'
      if (sandbox !== 'unsandboxed') {
        frame.setAttribute(
          'sandbox',
          `allow-scripts allow-popups${sandbox === 'escape' ? ' allow-popups-to-escape-sandbox' : ''}`
        )
      }
      frame.srcdoc =
        kind === 'script'
          ? `<button id="open" onclick="window.open('${destination}', '_blank', 'noopener')">Open</button>`
          : `<a id="open" href="${destination}" target="_blank" rel="noopener">Open</a>`
      document.body.append(frame)
    },
    { sandbox, destination, kind }
  )
  await page
    .frameLocator('#sandbox-probe')
    .locator('#open')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
  // A replacement iframe needs current compositor hit testing before hidden CDP input.
  await page.screenshot()
}

async function exerciseSandboxControls(
  path: CreationPath,
  kind: 'script' | 'link'
): Promise<Record<string, unknown>[]> {
  const page = guest('probe-one')
  await configure(page, path)
  const records: Record<string, unknown>[] = []
  for (const sandbox of ['restricted', 'escape', 'unsandboxed']) {
    const destination = `${origin}/sandbox-${path}-${kind}-${sandbox}`
    const offset = status().adapterProbe?.length ?? 0
    await installSandboxFrame(page, sandbox, destination, kind)
    const initialReceipt = receipts.length
    const open = page.frameLocator('#sandbox-probe').locator('#open')
    await waitForHiddenFrameInput(open)
    await open.click(kind === 'link' ? { modifiers: ['Shift'] } : {})
    if (path === 'adopted' && kind === 'link') {
      await expect
        .poll(() => eventsSince(offset).some((event) => event.event === 'createWindow-missing'))
        .toBe(true)
      const creation = eventsSince(offset).find((event) => event.event === 'createWindow-missing')
      if (!creation) {
        throw new Error('Missing OpenURL options')
      }
      records.push(creation)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(
        receipts.slice(initialReceipt).some((receipt) => destination.endsWith(receipt.path))
      ).toBe(false)
      snapshots.push(status())
      await configureProbe(page, 'cleanup')
      continue
    }
    const child = await childAt(destination)
    expect(await child.evaluate('window.opener === null')).toBe(true)
    const before = receipts.length
    await child.evaluate((action) => {
      const form = document.createElement('form')
      form.action = action
      form.method = 'POST'
      document.body.append(form)
      form.submit()
    }, `${origin}/sandbox-form-${path}-${kind}-${sandbox}`)
    if (sandbox === 'restricted') {
      await expect
        .poll(() => eventsSince(offset).some((event) => event.event === 'sandbox-form-blocked'))
        .toBe(true)
      expect(
        receipts.slice(before).some((receipt) => receipt.path.startsWith('/sandbox-form-'))
      ).toBe(false)
      expect(child.url()).toBe(destination)
    } else {
      await expect
        .poll(() =>
          receipts.slice(before).some((receipt) => receipt.path.startsWith('/sandbox-form-'))
        )
        .toBe(true)
    }
    await page.evaluate('console.log("orca-popup-fixture:snapshot")')
    const creation = eventsSince(offset).find(
      (event) =>
        event.event ===
        (path === 'adopted'
          ? kind === 'script'
            ? 'createWindow'
            : 'createWindow-missing'
          : 'did-create-window')
    )
    if (!creation) {
      throw new Error('Missing creation event')
    }
    records.push(creation)
    expect(status().windowsHidden).toBe(true)
    snapshots.push(status())
    await closeChildren(page)
  }
  return records
}
