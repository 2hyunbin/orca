import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CdpWsProxy } from './cdp-ws-proxy'
import { runWithRemoteCliPageAdmission } from './remote-cli-page-admission'
import { sendGuestCdpCommand } from './guest-cdp-command'
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

const PAGE_ID = 7
const REVOKED = 'The Orca desktop stopped sharing its browser before this command ran.'

function mouseEvents(mock: MockWebContents): string[] {
  return mock.webContents.debugger.sendCommand.mock.calls
    .filter((call) => call[0] === 'Input.dispatchMouseEvent')
    .map((call) => String(call[1]?.type))
}

describe('CdpWsProxy under a host command', () => {
  let mock: MockWebContents
  let proxy: CdpWsProxy
  let endpoint: string
  let guardFocus: () => Promise<() => void>

  beforeEach(async () => {
    mock = createMockWebContents()
    guardFocus = async () => () => {}
    const page = { ...mock.webContents, id: PAGE_ID }
    proxy = new CdpWsProxy(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock implements every WebContents member the proxy calls.
      page as never,
      () => () => {},
      () => guardFocus()
    )
    endpoint = await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
  })

  it('refuses every helper step after the host is revoked, without sending it to the page', async () => {
    let revoked = false
    let finish = (): void => {}
    const held = runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        if (revoked) {
          throw new Error(REVOKED)
        }
      },
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const client = await connect(endpoint)
    const press = { type: 'mouseMoved', x: 1, y: 1 }

    const allowed = await sendAndReceive(client, {
      id: 1,
      method: 'Input.dispatchMouseEvent',
      params: press
    })
    revoked = true
    const refused = await sendAndReceive(client, {
      id: 2,
      method: 'Input.dispatchMouseEvent',
      params: press
    })

    expect(allowed.error).toBeUndefined()
    expect(refused).toMatchObject({ id: 2, error: { message: REVOKED } })
    expect(mouseEvents(mock)).toEqual(['mouseMoved'])
    finish()
    await held
    client.close()
  })

  it('drops a press it accepted before the revocation but had not delivered yet', async () => {
    mock.webContents.getType.mockReturnValue('webview')
    let grantFocus = (): void => {}
    guardFocus = () => new Promise((resolve) => (grantFocus = () => resolve(() => {})))
    let revoked = false
    let finish = (): void => {}
    const held = runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        if (revoked) {
          throw new Error(REVOKED)
        }
      },
      () => new Promise<void>((resolve) => (finish = resolve))
    )
    const client = await connect(endpoint)

    const reply = sendAndReceive(client, {
      id: 3,
      method: 'Input.dispatchMouseEvent',
      params: { type: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1 }
    })
    await vi.waitFor(() =>
      expect(getSendCommandMethods(mock)).toContain('Emulation.setFocusEmulationEnabled')
    )
    revoked = true
    grantFocus()

    await expect(reply).resolves.toMatchObject({ id: 3, error: { message: REVOKED } })
    expect(mouseEvents(mock)).toEqual([])
    finish()
    await held
    client.close()
  })

  it('forwards commands again once the host command ends', async () => {
    await runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        throw new Error(REVOKED)
      },
      async () => {}
    )
    const client = await connect(endpoint)

    const response = await sendAndReceive(client, {
      id: 4,
      method: 'Accessibility.getFullAXTree',
      params: {}
    })

    expect(response.error).toBeUndefined()
    expect(getSendCommandMethods(mock)).toContain('Accessibility.getFullAXTree')
    client.close()
  })

  it('never refuses the desktop its own page commands while a revoked host command unwinds', async () => {
    let finish = (): void => {}
    const held = runWithRemoteCliPageAdmission(
      PAGE_ID,
      () => {
        throw new Error(REVOKED)
      },
      () => new Promise<void>((resolve) => (finish = resolve))
    )

    await expect(
      sendGuestCdpCommand(
        { ...mock.webContents, id: PAGE_ID },
        'Emulation.setDeviceMetricsOverride',
        {
          width: 400,
          height: 300,
          deviceScaleFactor: 1,
          mobile: false
        }
      )
    ).resolves.toEqual({})
    finish()
    await held
  })
})
