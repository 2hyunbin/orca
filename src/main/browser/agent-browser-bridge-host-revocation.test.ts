import { describe, it, expect, vi, beforeEach } from 'vitest'

const { execFileMock, webContentsFromIdMock, existsSyncMock, readFileSyncMock, stdinWrites } =
  vi.hoisted(() => ({
    execFileMock: vi.fn(),
    webContentsFromIdMock: vi.fn(),
    existsSyncMock: vi.fn(() => false),
    readFileSyncMock: vi.fn(() => Buffer.from('')),
    stdinWrites: [] as string[]
  }))

vi.mock('child_process', () => ({ execFile: execFileMock }))
vi.mock('fs', () => ({
  existsSync: existsSyncMock,
  readFileSync: readFileSyncMock,
  accessSync: vi.fn(),
  chmodSync: vi.fn(),
  constants: { X_OK: 1 }
}))
vi.mock('os', () => ({ platform: () => 'darwin', arch: () => 'arm64' }))
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/app'), getAppPath: vi.fn(() => '/project'), isPackaged: false },
  webContents: { fromId: webContentsFromIdMock }
}))
const { CdpWsProxyMock } = vi.hoisted(() => {
  const instances: unknown[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MockClass = vi.fn().mockImplementation(function (this: any, _wc: unknown) {
    this._wc = _wc
    this.start = vi.fn(async () => 'ws://127.0.0.1:9222')
    this.stop = vi.fn(async () => {})
    this.getPort = vi.fn(() => 9222)
    this.setCommandGate = vi.fn()
    instances.push(this)
  })
  return { CdpWsProxyMock: Object.assign(MockClass, { instances }) }
})
vi.mock('./cdp-ws-proxy', () => ({ CdpWsProxy: CdpWsProxyMock }))

import { AgentBrowserBridge } from './agent-browser-bridge'
import { runInRemoteCliBrowserScope } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  createFakeAgentBrowserChild,
  mockBrowserManager,
  mockWebContents,
  overrideBridgeWebContentsLookup,
  resetAgentBrowserBridgeMocks,
  type ExecFileCallback
} from './agent-browser-bridge-test-harness'

overrideBridgeWebContentsLookup(AgentBrowserBridge.prototype, webContentsFromIdMock)

const WORKSPACE = 'repo-host::/srv/app'

function dispatchedMouseEvents(wc: ReturnType<typeof mockWebContents>): unknown[] {
  return wc.debugger.sendCommand.mock.calls.filter((call) => call[0] === 'Input.dispatchMouseEvent')
}

describe('AgentBrowserBridge under a host revocation', () => {
  let bridge: AgentBrowserBridge

  beforeEach(() => {
    resetAgentBrowserBridgeMocks({
      webContentsFromIdMock,
      existsSyncMock,
      readFileSyncMock,
      stdinWrites,
      cdpWsProxyInstances: CdpWsProxyMock.instances
    })
    bridge = new AgentBrowserBridge(mockBrowserManager())
    bridge.setActiveTab(100)
  })

  it('never presses the mouse once the host is revoked during a running click', async () => {
    const wc = mockWebContents(100)
    let answerHitTest = (): void => {}
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        await new Promise<void>((resolve) => {
          answerHitTest = resolve
        })
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)
    const revoked = new AbortController()

    const click = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18),
      revoked.signal
    )
    await vi.waitFor(() =>
      expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
    )
    revoked.abort()
    answerHitTest()

    await expect(click).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    expect(dispatchedMouseEvents(wc)).toHaveLength(0)
  })

  it('gates the page proxy against a running helper click once the host is revoked', async () => {
    const helperCallbacks: ExecFileCallback[] = []
    execFileMock.mockImplementation(
      (_bin: string, args: string[], _opts: unknown, cb: ExecFileCallback) => {
        if (args.includes('click')) {
          helperCallbacks.push(cb)
        } else {
          cb(null, JSON.stringify({ success: true, data: null }), '')
        }
        return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
      }
    )
    const revoked = new AbortController()

    const click = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.click('@e1', undefined, 'tab-1'),
      revoked.signal
    )
    await vi.waitFor(() => expect(helperCallbacks).toHaveLength(1))
    const proxy = CdpWsProxyMock.instances[0] as { setCommandGate: ReturnType<typeof vi.fn> }
    const gate = proxy.setCommandGate.mock.calls.at(-1)?.[0] as (() => void) | null
    expect(gate).toBeTypeOf('function')
    expect(() => gate!()).not.toThrow()

    revoked.abort()
    // The helper's next CDP step reaches the proxy and is refused there.
    expect(() => gate!()).toThrow('stopped sharing')
    helperCallbacks[0]!(
      null,
      JSON.stringify({ success: false, error: 'The Orca desktop stopped sharing its browser' }),
      ''
    )

    await expect(click).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    expect(proxy.setCommandGate).toHaveBeenLastCalledWith(null)
  })

  it('leaves a desktop-local command ungated', async () => {
    execFileMock.mockImplementation(
      (_bin: string, _args: string[], _opts: unknown, cb: ExecFileCallback) => {
        cb(null, JSON.stringify({ success: true, data: { clicked: '@e1' } }), '')
        return createFakeAgentBrowserChild({ stdin: { on: vi.fn(), end: vi.fn() } })
      }
    )

    await expect(bridge.click('@e1', undefined, 'tab-1')).resolves.toEqual({ clicked: '@e1' })
    const proxy = CdpWsProxyMock.instances[0] as { setCommandGate: ReturnType<typeof vi.fn> }
    expect(proxy.setCommandGate).not.toHaveBeenCalled()
  })

  it('still runs a desktop-local command queued behind a host command that was revoked', async () => {
    const wc = mockWebContents(100)
    let answerHitTest = (): void => {}
    wc.debugger.sendCommand.mockImplementation(async (method: string) => {
      if (method === 'Runtime.evaluate') {
        await new Promise<void>((resolve) => {
          answerHitTest = resolve
        })
        return { result: { value: { x: 10, y: 20, adjusted: false, handled: false } } }
      }
      return {}
    })
    webContentsFromIdMock.mockReturnValue(wc)
    const revoked = new AbortController()
    const hostClick = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18),
      revoked.signal
    )
    hostClick.catch(() => {})
    await vi.waitFor(() =>
      expect(wc.debugger.sendCommand).toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
    )

    const localMove = bridge.mouseMove(5, 6, undefined, 'tab-1')
    revoked.abort()
    answerHitTest()

    await expect(hostClick).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    await expect(localMove).resolves.toBeDefined()
    expect(dispatchedMouseEvents(wc)).toEqual([
      ['Input.dispatchMouseEvent', expect.objectContaining({ type: 'mouseMoved', x: 5, y: 6 })]
    ])
  })

  it('never hit-tests (which can activate the element) once revoked during the focus wait', async () => {
    let grantFocus = (): void => {}
    const release = vi.fn()
    const guardUserFocusForAgentInput = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          grantFocus = () => resolve(release)
        })
    )
    bridge = new AgentBrowserBridge(
      mockBrowserManager(undefined, undefined, { guardUserFocusForAgentInput })
    )
    bridge.setActiveTab(100)
    const wc = mockWebContents(100)
    wc.getType.mockReturnValue('webview')
    wc.debugger.sendCommand.mockResolvedValue({})
    webContentsFromIdMock.mockReturnValue(wc)
    const revoked = new AbortController()

    const click = runInRemoteCliBrowserScope(
      WORKSPACE,
      () => bridge.mouseClick(10, 20, 'left', undefined, 'tab-1', 18),
      revoked.signal
    )
    await vi.waitFor(() => expect(guardUserFocusForAgentInput).toHaveBeenCalled())
    revoked.abort()
    grantFocus()

    await expect(click).rejects.toMatchObject({ code: 'desktop_browser_bridge_unavailable' })
    expect(wc.debugger.sendCommand).not.toHaveBeenCalledWith('Runtime.evaluate', expect.anything())
    expect(dispatchedMouseEvents(wc)).toHaveLength(0)
    expect(release).toHaveBeenCalled()
  })
})
