/**
 * Watching for stop requests addressed to this orcad.
 *
 * Two listeners share one shutdown: the plain slot request (`.orcad-stop-request` beside
 * `orcad.js`, consumed by unlinking it) and the instance-bound managed request in the data
 * root, which is validated and kept as evidence until the completion command proves exit.
 */
import { lstatSync, unlinkSync, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  ORCAD_STOP_NOW_REQUEST,
  ORCAD_STOP_REQUEST_FILENAME,
  ORCAD_STOP_REQUEST_MAX_BYTES,
  type OrcadManagedStopContext,
  type OrcadManagedStopRequest
} from '../../shared/orcad-stop-request'
import {
  orcadManagedStopRequestPath,
  validateOrcadManagedStopRequest
} from './orcad-managed-stop-request'
import { claimOrcadManagedStopDecision } from './orcad-managed-stop-decision'
import { withdrawOrcadManagedStopRequest } from './orcad-managed-stop-cancellation'
import { hasErrorCode } from '../daemon/daemon-process-inspection'

export type OrcadStopRequestListener = { close(): void }

const DEFAULT_POLL_INTERVAL_MS = 1_000

/** `consume` returns the request that should stop orcad, or null; a missing file throws ENOENT. */
function listenForRequest<T>(
  requestPath: string,
  consume: (path: string) => T | null,
  onRequest: (request: T) => void,
  pollIntervalMs: number
): OrcadStopRequestListener {
  let closed = false
  let lastFailure: string | null = null
  const check = (): void => {
    if (closed) {
      return
    }
    let request: T | null
    try {
      request = consume(requestPath)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) {
        // Polling retries every interval; report each distinct refusal once.
        const failure = error instanceof Error ? error.message : String(error)
        if (failure !== lastFailure) {
          lastFailure = failure
          console.error(`[orcad] refused stop request at ${requestPath}:`, error)
        }
      }
      return
    }
    if (request === null) {
      return
    }
    closed = true
    stop()
    onRequest(request)
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(dirname(requestPath), (_event, changed) => {
      if (!changed || basename(String(changed)) === basename(requestPath)) {
        check()
      }
    })
    watcher.on('error', (error) => console.error('[orcad] stop-request watcher failed:', error))
    watcher.unref()
  } catch (error) {
    // The poll below still delivers requests; a watcher only makes them prompt.
    console.error('[orcad] stop-request watcher could not start:', error)
  }
  const poll = setInterval(check, pollIntervalMs)
  poll.unref()
  const stop = (): void => {
    watcher?.close()
    clearInterval(poll)
  }
  // Covers a request written before this listener was installed.
  check()
  return {
    close: () => {
      closed = true
      stop()
    }
  }
}

/** Only the exact marker stops now; other contents take the chat-safe restart, and a directory,
 *  which cannot be unlinked, is refused and retried. */
function plainRequestStopsNow(path: string): boolean {
  const stats = lstatSync(path)
  const contents =
    stats.isFile() && stats.size <= ORCAD_STOP_REQUEST_MAX_BYTES
      ? readNodeFileSyncWithinLimit(path, ORCAD_STOP_REQUEST_MAX_BYTES, {
          regularFileOnly: true
        }).buffer.toString('utf8')
      : null
  if (contents !== '' && contents !== ORCAD_STOP_NOW_REQUEST) {
    console.error(`[orcad] unrecognized stop request at ${path}; restarting only when idle`)
  }
  return contents === ORCAD_STOP_NOW_REQUEST
}

export function installOrcadStopRequestListeners(
  onRequest: () => void,
  options: {
    installRoot: string
    managedStop?: OrcadManagedStopContext
    /** Runs once for a validated managed request before the stop; it cannot prevent it. */
    beforeManagedStop?: (request: OrcadManagedStopRequest) => Promise<void>
    /** An empty plain request: an older client's update, or its recovery stop. Two commands once
     *  shared the empty file, so only the "stop now" contents newer clients write still stop. */
    restartSlot?: () => Promise<void>
    pollIntervalMs?: number
  }
): OrcadStopRequestListener {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  // Declared first: a listener's initial check can consume a request and close before returning.
  const listeners: OrcadStopRequestListener[] = []
  const close = (): void => {
    for (const listener of listeners) {
      listener.close()
    }
  }
  listeners.push(
    listenForRequest(
      join(options.installRoot, ORCAD_STOP_REQUEST_FILENAME),
      (path) => {
        const stopNow = plainRequestStopsNow(path)
        unlinkSync(path)
        if (!stopNow && options.restartSlot) {
          void options
            .restartSlot()
            .catch((error: unknown) =>
              console.error('[orcad] slot restart admission failed:', error)
            )
          return null
        }
        return true
      },
      () => onRequest(),
      pollIntervalMs
    )
  )
  const managedStop = options.managedStop
  if (managedStop) {
    const prepare = options.beforeManagedStop ?? (async () => {})
    listeners.push(
      listenForRequest(
        orcadManagedStopRequestPath(managedStop.instance),
        (path) => {
          const request = validateOrcadManagedStopRequest(managedStop, path)
          // A cancelled request is never acted on; keep listening for the next transaction.
          if (claimOrcadManagedStopDecision(request, 'dispatched') === 'canceled') {
            // A cancelled request left behind would block every later transaction's request.
            withdrawOrcadManagedStopRequest(request)
            throw new Error('orcad_managed_stop_canceled')
          }
          return request
        },
        (request) => {
          close()
          // Preparation is best effort: whatever it reports, the stop proceeds.
          void prepare(request)
            .catch((error: unknown) =>
              console.error('[orcad] managed stop preparation failed:', error)
            )
            .finally(onRequest)
        },
        pollIntervalMs
      )
    )
  }
  return { close }
}
