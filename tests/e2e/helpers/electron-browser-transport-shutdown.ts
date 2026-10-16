import type { ChildProcess } from 'node:child_process'

function isPlaywrightObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Capture before Playwright removes the application dispatcher on process close. */
export function captureElectronBrowserTransportShutdown(
  app: unknown,
  proc: ChildProcess,
  platform: NodeJS.Platform = process.platform
): () => boolean {
  try {
    if (
      platform !== 'linux' ||
      !isPlaywrightObject(app) ||
      !isPlaywrightObject(app._connection) ||
      typeof app._connection.toImpl !== 'function'
    ) {
      return () => false
    }
    const implementation: unknown = app._connection.toImpl(app)
    return () => releaseExitedElectronBrowserTransport(implementation, proc)
  } catch {
    return () => false
  }
}

function releaseExitedElectronBrowserTransport(
  implementation: unknown,
  proc: ChildProcess
): boolean {
  if (proc.exitCode === null && proc.signalCode === null) {
    return false
  }
  try {
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
