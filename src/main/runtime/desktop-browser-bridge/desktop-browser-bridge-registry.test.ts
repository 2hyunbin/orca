import { describe, expect, it } from 'vitest'
import {
  DesktopBrowserBridgeRegistry,
  MAX_PENDING_PER_ATTACHMENT
} from './desktop-browser-bridge-registry'

describe('DesktopBrowserBridgeRegistry', () => {
  it('keeps waiting commands under what one desktop socket can answer at once', async () => {
    const registry = new DesktopBrowserBridgeRegistry()
    registry.attach({ connectionId: 'c', pairedDeviceId: 'd', emit: () => {} })
    const waiting = Array.from({ length: MAX_PENDING_PER_ATTACHMENT }, () =>
      registry.forward({ method: 'browser.snapshot', params: {} }, { timeoutMs: 60_000 })
    )
    for (const pending of waiting) {
      pending.catch(() => {})
    }

    await expect(
      registry.forward({ method: 'browser.snapshot', params: {} }, { timeoutMs: 60_000 })
    ).rejects.toMatchObject({ code: 'browser_busy' })
    expect(MAX_PENDING_PER_ATTACHMENT).toBeLessThan(32)
  })
})
