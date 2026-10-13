import { describe, expect, it } from 'vitest'
import {
  browser,
  closeChildren,
  enablePopupFixtureNativeControls,
  guest,
  origin,
  receipts,
  status
} from './browser-popup-compatibility-cdp-fixture'

enablePopupFixtureNativeControls()

describe('popup review request provenance', () => {
  it('preserves the native cross-site context for a remote foreground modifier click', async () => {
    const page = guest('route')
    const destination = origin.replace('127.0.0.1', 'localhost')
    await page
      .locator('#shift')
      .evaluate((link, url) => link.setAttribute('href', url), `${destination}/seed`)
    await page.locator('#shift').click({ modifiers: ['Shift'] })
    await expect
      .poll(() =>
        browser
          ?.contexts()
          .flatMap((context) => context.pages())
          .some((child) => child.url() === `${destination}/seed`)
      )
      .toBe(true)
    await closeChildren(page)
    const observed = []
    for (const name of ['route-control', 'route']) {
      const target = guest(name)
      const before = receipts.length
      await target
        .locator('#link')
        .evaluate((link, url) => link.setAttribute('href', url), `${destination}/foreground-review`)
      await target.locator('#link').click({ modifiers: ['ControlOrMeta', 'Shift'] })
      await expect
        .poll(() => receipts.slice(before).some((receipt) => receipt.path === '/foreground-review'))
        .toBe(true)
      observed.push(receipts.slice(before).find((receipt) => receipt.path === '/foreground-review'))
      await closeChildren(target)
    }
    expect(status().windowsHidden).toBe(true)
    expect(observed[0]).toMatchObject({
      cookie: '',
      referrer: `${origin}/`,
      fetchSite: 'cross-site'
    })
    expect(observed[1]).toEqual(observed[0])
  })
})
