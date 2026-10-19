import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import {
  connect,
  createMockWebContents,
  getSendCommandMethods,
  sendAndReceive,
  type MockWebContents
} from './cdp-ws-proxy-test-harness'

vi.mock('electron', () => ({
  webContents: { fromId: vi.fn() }
}))

describe('CdpWsProxy command gate', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string

  beforeEach(async () => {
    mock = createMockWebContents()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the proxy calls.
    proxy = new CdpWsProxy(mock.webContents as never, () => () => {})
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('refuses every later helper step once the gate closes, without sending it to the page', async () => {
    let revoked = false
    proxy.setCommandGate(() => {
      if (revoked) {
        throw new Error('The Orca desktop stopped sharing its browser before this command ran.')
      }
    })
    const client = await connect(endpoint)
    const press = { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }

    const allowed = await sendAndReceive(client, {
      id: 1,
      method: 'Input.dispatchMouseEvent',
      params: press
    })
    revoked = true
    const refused = await sendAndReceive(client, {
      id: 2,
      method: 'Input.dispatchMouseEvent',
      params: { ...press, type: 'mouseReleased' }
    })

    expect(allowed.error).toBeUndefined()
    expect(refused).toMatchObject({ id: 2, error: { message: expect.stringContaining('stopped') } })
    expect(
      mock.webContents.debugger.sendCommand.mock.calls.filter(
        (call) => call[0] === 'Input.dispatchMouseEvent'
      )
    ).toHaveLength(1)
    client.close()
  })

  it('forwards commands again once the gate is cleared', async () => {
    proxy.setCommandGate(() => {
      throw new Error('revoked')
    })
    proxy.setCommandGate(null)
    const client = await connect(endpoint)

    const response = await sendAndReceive(client, {
      id: 3,
      method: 'Accessibility.getFullAXTree',
      params: {}
    })

    expect(response.error).toBeUndefined()
    expect(getSendCommandMethods(mock)).toContain('Accessibility.getFullAXTree')
    client.close()
  })
})
