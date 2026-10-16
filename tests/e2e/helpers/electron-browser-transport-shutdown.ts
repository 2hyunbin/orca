import type { ChildProcess } from 'node:child_process'

function isPlaywrightObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A dead Electron can leave its CDP socket inherited by a surviving Linux child. */
export function releaseExitedElectronBrowserTransport(
  app: unknown,
  proc: ChildProcess,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform !== 'linux' || (proc.exitCode === null && proc.signalCode === null)) {
    return false
  }
  try {
    if (!isPlaywrightObject(app) || !isPlaywrightObject(app._connection)) {
      return false
    }
    const bridge = app._connection
    if (typeof bridge.toImpl !== 'function') {
      return false
    }
    const implementation: unknown = bridge.toImpl(app)
    if (
      !isPlaywrightObject(implementation) ||
      implementation._process !== proc ||
      !isPlaywrightObject(implementation._nodeConnection) ||
      implementation._nodeConnection._closed !== true ||
      !isPlaywrightObject(implementation._browserContext) ||
      !isPlaywrightObject(implementation._browserContext._browser)
    ) {
      return false
    }
    const browser = implementation._browserContext._browser
    if (
      !isPlaywrightObject(browser.options) ||
      !isPlaywrightObject(browser.options.browserProcess) ||
      browser.options.browserProcess.process !== proc ||
      !isPlaywrightObject(browser._connection)
    ) {
      return false
    }
    const connection = browser._connection
    if (
      connection._closed !== false ||
      !(connection._sessions instanceof Map) ||
      !connection._sessions.has('')
    ) {
      return false
    }
    for (const session of connection._sessions.values()) {
      if (
        !isPlaywrightObject(session) ||
        !(session._callbacks instanceof Map) ||
        session._callbacks.size !== 0
      ) {
        return false
      }
    }
    if (
      !isPlaywrightObject(connection._transport) ||
      !isPlaywrightObject(connection._transport._ws)
    ) {
      return false
    }
    const socket = connection._transport._ws
    if (
      (socket.readyState !== 1 && socket.readyState !== 2) ||
      typeof socket.terminate !== 'function'
    ) {
      return false
    }
    // Close the real owned socket so Playwright runs its normal disconnect/context cleanup.
    socket.terminate()
    return true
  } catch {
    // Unknown SDK shapes retain the existing graceful-close timeout and fallback.
    return false
  }
}
