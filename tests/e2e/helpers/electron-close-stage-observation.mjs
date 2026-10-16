import { safely, createCloseStageMethods } from './electron-close-stage-methods.mjs'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

const EVENT_LIMIT = 256
const WORKER_BYTE_LIMIT = 1024 * 1024
const OVERFLOW_RESERVE = 512
const PREFIX = '[e2e:close-stage] '
const activeApps = new WeakMap()
let nextCloseId = 0
let workerBytes = 0
let workerLimitReported = false

const inert = Object.freeze({ flush() {}, dispose() {} })

export function observeElectronCloseStages(app) {
  if (process.env.ORCA_E2E_CLOSE_STAGE_OBSERVATION !== '1') {
    return inert
  }
  return safely(() => attach(app)) ?? inert
}

function attach(app) {
  if (!app || (typeof app !== 'object' && typeof app !== 'function')) {
    return inert
  }
  if (activeApps.has(app)) {
    return inert
  }
  const started = performance.now()
  const closeId = ++nextCloseId
  const lines = []
  const undo = []
  const pending = new Map()
  let active = true
  let events = 0
  let eventLimitReported = false
  let pid = 0
  let flushIndex = 0
  let customCalls = 0
  let handleObserved = false
  let nodeConnection
  let browserConnection
  let clientContext
  let serverContext

  const append = (stage, terminal = false) => {
    if (!active) {
      return
    }
    if (!terminal && events >= EVENT_LIMIT - 1) {
      if (!eventLimitReported) {
        eventLimitReported = true
        append('observer.event-limit', true)
      }
      return
    }
    if (events >= EVENT_LIMIT) {
      return
    }
    const elapsedMs = Math.round((performance.now() - started) * 1000) / 1000
    const line = `${PREFIX + JSON.stringify({ stage, elapsedMs, closeId, pid, workerPid: process.pid })}\n`
    const bytes = Buffer.byteLength(line)
    if (workerBytes + bytes > WORKER_BYTE_LIMIT - OVERFLOW_RESERVE) {
      if (!workerLimitReported && workerBytes + bytes <= WORKER_BYTE_LIMIT) {
        workerLimitReported = true
        const overflow = `${PREFIX + JSON.stringify({ stage: 'observer.worker-byte-limit', elapsedMs, closeId, pid, workerPid: process.pid })}\n`
        const overflowBytes = Buffer.byteLength(overflow)
        if (workerBytes + overflowBytes <= WORKER_BYTE_LIMIT) {
          lines.push(overflow)
          workerBytes += overflowBytes
          events++
        }
      }
      return
    }
    lines.push(line)
    workerBytes += bytes
    events++
  }
  const record = (stage) => safely(() => append(stage))
  const unavailable = (stage) => record(`${stage}.unavailable`)
  const { wrap, proxyField, listen, promise, snapshotConnection, connection } =
    createCloseStageMethods({ isActive: () => active, record, unavailable, undo, pending })

  const flush = () =>
    safely(() => {
      for (; flushIndex < lines.length; flushIndex++) {
        safely(() => process.stderr.write(lines[flushIndex]))
      }
    })
  const dispose = () =>
    safely(() => {
      if (!active) {
        return
      }
      record('observer.dispose')
      for (const [stage, count] of pending) {
        if (count > 0) {
          record(`${stage}.outstanding-at-dispose`)
        }
      }
      snapshotConnection(nodeConnection, 'node')
      snapshotConnection(browserConnection, 'browser')
      active = false
      for (let index = undo.length - 1; index >= 0; index--) {
        safely(undo[index])
      }
      undo.length = 0
      pending.clear()
      activeApps.delete(app)
      flush()
    })
  const observer = Object.freeze({ flush, dispose })
  activeApps.set(app, observer)

  let setupComplete = false
  safely(() => {
    const proc = safely(() => app.process?.())
    if (Number.isSafeInteger(proc?.pid) && proc.pid > 0) {
      pid = proc.pid
    }
    record('observer.attached')
    listen(proc, 'exit', 'child.exit', () => {
      snapshotConnection(nodeConnection, 'node')
      snapshotConnection(browserConnection, 'browser')
    })
    listen(proc, 'close', 'child.close', () => {
      snapshotConnection(nodeConnection, 'node')
      snapshotConnection(browserConnection, 'browser')
    })
    listen(app, 'close', 'client.application.close-event')
    clientContext = safely(() => app.context?.())
    const serverApp = safely(() => app._connection?.toImpl?.(app))
    serverContext = serverApp?._browserContext
    nodeConnection = serverApp?._nodeConnection
    const browser = serverContext?._browser
    browserConnection = browser?._connection
    if (!serverApp) {
      unavailable('bridge.server-app')
    }
    if (!serverContext) {
      unavailable('bridge.server-context')
    }

    wrap(app, 'close', 'client.application.close')
    wrap(clientContext, 'close', 'client.context.close')
    wrap(clientContext?.request, 'dispose', 'client.request.dispose')
    proxyField(
      clientContext,
      '_instrumentation',
      'runBeforeCloseBrowserContext',
      'client.before-context-close'
    )
    proxyField(
      clientContext?.request,
      '_instrumentation',
      'runBeforeCloseRequestContext',
      'client.before-request-close'
    )
    wrap(clientContext?.tracing, '_exportAllHars', 'client.context.har-export')
    wrap(clientContext?.request?.tracing, '_exportAllHars', 'client.request.har-export')
    proxyField(clientContext, '_channel', 'close', 'client.context.channel-close')
    proxyField(clientContext?.request, '_channel', 'dispose', 'client.request.channel-dispose')
    promise(clientContext, '_closedPromise', 'client.context.closed-promise')
    listen(clientContext, 'close', 'client.context.close-event')

    wrap(serverContext, 'close', 'server.context.close')
    wrap(serverContext?.tracing, 'flush', 'server.context.trace-flush')
    wrap(serverContext?.fetchRequest?.tracing?.(), 'flush', 'server.request.trace-flush')
    wrap(
      serverContext,
      '_customCloseHandler',
      'server.custom-close',
      () => {
        customCalls++
        if (!handleObserved) {
          record('server.node-handle.not-observed-at-custom-enter')
        }
      },
      () => {
        customCalls = Math.max(0, customCalls - 1)
      }
    )
    wrap(serverContext, '_deleteAllDownloads', 'server.download-delete')
    wrap(serverContext, '_deleteAllTempDirs', 'server.temp-delete')
    wrap(serverContext, '_didCloseInternal', 'server.context.finalize')
    promise(serverContext, '_closePromise', 'server.context.closed-promise')
    listen(serverContext, 'close', 'server.context.close-event')
    listen(serverApp, 'close', 'server.application.close-event')
    wrap(browser, '_didDisconnect', 'server.browser.did-disconnect')
    listen(browser, 'disconnected', 'server.browser.disconnected-event')
    const pages = serverContext?.pages?.()
    if (Array.isArray(pages)) {
      for (let index = 0; index < pages.length; index++) {
        wrap(pages[index]?.screencast, 'handlePageOrContextClose', `server.screencast-${index}`)
      }
    } else {
      unavailable('server.screencasts')
    }
    promise(serverApp, '_nodeElectronHandlePromise', 'server.node-handle', (handle) => {
      if (!active || !handle) {
        return
      }
      handleObserved = true
      if (customCalls > 0) {
        record('server.node-handle.observed-after-custom-enter')
      }
      wrap(handle, 'evaluate', 'server.node-handle.evaluate', () => {
        record(
          customCalls > 0
            ? 'server.node-evaluate.during-custom-close'
            : 'server.node-evaluate.outside-custom-close'
        )
      })
    })
    connection(nodeConnection, 'node')
    connection(browserConnection, 'browser')
    snapshotConnection(nodeConnection, 'node')
    snapshotConnection(browserConnection, 'browser')
    setupComplete = true
  })
  if (!setupComplete) {
    unavailable('observer.setup-incomplete')
  }
  return observer
}
