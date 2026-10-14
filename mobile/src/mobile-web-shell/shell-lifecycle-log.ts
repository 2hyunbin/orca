import { connectionLogStore } from '../transport/persisted-connection-log-store'
import type { ConnectionLogEntry } from '../transport/types'
import type { BridgeErrorCapture } from './bridge/bridge-error-capture'
import type { BridgeHostDiagnostic } from './bridge-host-contract'
import type {
  MobileWebShellSession,
  MobileWebShellSessionEvent,
  MobileWebShellSessionState
} from './mobile-web-shell-session-contract'

/**
 * Sparse OTA shell milestones for the per-host connection log, so an exported report says where a
 * workspace open stalled. Diagnostics only: nothing here feeds back into the session.
 *
 * The store holds 200 entries shared with connection events, so only state changes, first-time page
 * signals and one-shot warnings are written — never progress ticks. Route paths, generation
 * directories and error stacks stay out: they can name user paths.
 */
export type ShellLifecycleLine = Required<Pick<ConnectionLogEntry, 'level' | 'message' | 'code'>> &
  Pick<ConnectionLogEntry, 'detail'>

/** How long a stuck "Opening workspace" waits before the log says so; past the 10 s ready deadline. */
export const SHELL_STALL_LOG_MS = 15_000

const BUILD_ID_PREFIX_LENGTH = 8
const FAULT_DETAIL_MAX_CHARS = 160

let lineSequence = 0

export function recordShellLifecycleLine(hostId: string, line: ShellLifecycleLine): void {
  const ts = Date.now()
  lineSequence += 1
  connectionLogStore.append(hostId, { id: `web-shell-${ts}-${lineSequence}`, ts, ...line })
}

/** What one reducer step is worth logging; empty for most steps. */
export function shellSessionStepLines(
  before: MobileWebShellSession,
  event: MobileWebShellSessionEvent,
  after: MobileWebShellSession
): ShellLifecycleLine[] {
  // A superseded flow's result changed nothing and says nothing about this one.
  if ('flow' in event && event.flow !== before.flow) {
    return []
  }
  const lines = [...eventLines(before, event)]
  const transition = transitionLine(before.state, after.state)
  if (transition !== null) {
    lines.push(transition)
  }
  return lines
}

/** The one-shot warning for a session parked behind "Opening workspace", or null when not parked. */
export function shellStallLine(
  state: MobileWebShellSessionState,
  session: Pick<MobileWebShellSession, 'pagePainted' | 'pageReady'>
): ShellLifecycleLine | null {
  const seconds = `${SHELL_STALL_LOG_MS / 1000}s`
  if (state.kind === 'activating') {
    return stallLine(`Web shell: still activating after ${seconds}`, `source=${state.source}`)
  }
  if (state.kind === 'ready' && !session.pagePainted) {
    return stallLine(
      `Web shell: page has not drawn after ${seconds}`,
      `page ready=${session.pageReady ? 'yes' : 'no'}`
    )
  }
  return null
}

/** Null for routine kinds; the caller already bounds each key to one line per host. */
export function bridgeDiagnosticLine(diagnostic: BridgeHostDiagnostic): ShellLifecycleLine | null {
  // Retired terminal streams are routine and one per stream; they would crowd out the log.
  if (diagnostic.kind === 'terminal-backlog') {
    return null
  }
  const detail =
    diagnostic.kind === 'refused'
      ? diagnostic.refusal
      : diagnostic.kind === 'notify-refused' || diagnostic.kind === 'navigate-back-refused'
        ? diagnostic.why
        : undefined
  return {
    level: 'warn',
    code: 'web-shell-bridge',
    message: `Web shell bridge: ${diagnostic.kind}`,
    ...(detail === undefined ? {} : { detail })
  }
}

export function pageFaultLine(error: BridgeErrorCapture): ShellLifecycleLine {
  return pageLine('warn', 'Web shell: page faulted', `${error.category}: ${shortFaultText(error)}`)
}

function eventLines(
  before: MobileWebShellSession,
  event: MobileWebShellSessionEvent
): ShellLifecycleLine[] {
  if (event.type === 'download-failed') {
    const code = event.cause.hostCode === null ? '' : ` code=${event.cause.hostCode}`
    return [
      flowLine('warn', 'Web shell: app download failed', `reason=${event.cause.reason}${code}`)
    ]
  }
  // Every page signal below is only accepted while a generation is on screen.
  if (before.state.kind !== 'ready') {
    return []
  }
  switch (event.type) {
    case 'document-loaded':
      return [pageLine('info', 'Web shell: page document loaded')]
    case 'shell-failed':
      return [pageLine('warn', 'Web shell: page load failed', `reason=${event.reason}`)]
    case 'page-ready':
      return before.pageReady ? [] : [pageLine('info', 'Web shell: page ready')]
    case 'page-painted':
      return before.pagePainted ? [] : [pageLine('success', 'Web shell: page painted')]
    case 'page-ready-deadline':
      return before.pageReady
        ? []
        : [pageLine('warn', 'Web shell: page never said ready before the deadline')]
    case 'document-started':
    case 'gates-changed':
    case 'cache-read':
    case 'manifest-read':
    case 'fetch-progress':
    case 'download-staged':
    case 'activated':
    case 'remounted':
    case 'page-back-claim':
    case 'layout-changed':
    case 'retry-pressed':
      // Logged, if at all, as the state change they cause; a document start is implied by its load.
      return []
  }
}

function transitionLine(
  before: MobileWebShellSessionState,
  after: MobileWebShellSessionState
): ShellLifecycleLine | null {
  if (after.kind === 'ready' && before.kind === 'ready') {
    return before.sessionId === after.sessionId
      ? null
      : flowLine('info', 'Web shell: page view remounted')
  }
  if (before.kind === after.kind) {
    return null
  }
  switch (after.kind) {
    case 'checking':
      return flowLine('info', 'Web shell: checking host')
    case 'offline':
      return flowLine('warn', 'Web shell: host unreachable and no app cached')
    case 'fetching':
      return flowLine(
        'info',
        'Web shell: downloading app',
        `${after.totalAssets} assets, ${after.totalBytes} bytes`
      )
    case 'activating':
      // A cache activation is immediate and shows up as the `ready` line's source.
      return after.source === 'download'
        ? flowLine('info', 'Web shell: activating app', 'source=download')
        : null
    case 'ready': {
      const source = before.kind === 'activating' ? `source=${before.source} ` : ''
      const build = after.buildId.slice(0, BUILD_ID_PREFIX_LENGTH)
      return flowLine(
        'success',
        'Web shell: app opened',
        `${source}build=${build} elapsed=${after.elapsedMs}ms`
      )
    }
    case 'native-route':
      // The normal outcome for every native screen; logging it would crowd out connection events.
      return null
    case 'wall': {
      const side = 'side' in after.verdict ? ` side=${after.verdict.side}` : ''
      return flowLine(
        'warn',
        'Web shell: blocked by version check',
        `reason=${after.verdict.reason}${side}`
      )
    }
    case 'failed':
      return flowLine(
        'error',
        'Web shell: failed',
        `reason=${after.reason} retried=${after.retriedOnce ? 'yes' : 'no'}`
      )
  }
}

/** First line only, absolute paths and file URLs masked, then clamped. */
function shortFaultText(error: BridgeErrorCapture): string {
  const firstLine = error.message.split(/\r?\n/, 1)[0] ?? ''
  const masked = firstLine
    .replace(/file:\/\/\S+/g, '[path]')
    .replace(/(^|\s)(?:~?\/|[A-Za-z]:[\\/])\S+/g, '$1[path]')
  return masked.length > FAULT_DETAIL_MAX_CHARS
    ? `${masked.slice(0, FAULT_DETAIL_MAX_CHARS)}…`
    : masked
}

function flowLine(
  level: ShellLifecycleLine['level'],
  message: string,
  detail?: string
): ShellLifecycleLine {
  return { level, code: 'web-shell-flow', message, ...(detail === undefined ? {} : { detail }) }
}

function pageLine(
  level: ShellLifecycleLine['level'],
  message: string,
  detail?: string
): ShellLifecycleLine {
  return { level, code: 'web-shell-page', message, ...(detail === undefined ? {} : { detail }) }
}

function stallLine(message: string, detail: string): ShellLifecycleLine {
  return { level: 'warn', code: 'web-shell-stalled', message, detail }
}
