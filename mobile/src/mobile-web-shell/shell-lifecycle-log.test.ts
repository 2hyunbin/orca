import { describe, expect, it, vi } from 'vitest'
import { buildConnectionDiagnosticsReport } from '../diagnostics/connection-diagnostics-report'
import type { ConnectionLogEntry } from '../transport/types'
import {
  CACHED,
  MANIFEST,
  createMobileWebShellSession,
  gates,
  ROUTE,
  stamp
} from './mobile-web-shell-session-test-fixtures'
import { reduceMobileWebShellSession } from './mobile-web-shell-session'
import type {
  MobileWebShellSession,
  MobileWebShellSessionEvent
} from './mobile-web-shell-session-contract'
import {
  bridgeDiagnosticLine,
  pageFaultLine,
  shellSessionStepLines,
  shellStallLine,
  type ShellLifecycleLine
} from './shell-lifecycle-log'

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => undefined) }
}))

type Pending = Parameters<typeof stamp>[1]

/** Replays events through the real reducer, collecting what each step would log. */
function replay(
  events: readonly Pending[],
  from: MobileWebShellSession = createMobileWebShellSession(ROUTE)
): { session: MobileWebShellSession; lines: ShellLifecycleLine[] } {
  let session = from
  const lines: ShellLifecycleLine[] = []
  for (const pending of events) {
    const event: MobileWebShellSessionEvent = stamp(session.flow, pending)
    const next = reduceMobileWebShellSession(session, event).session
    lines.push(...shellSessionStepLines(session, event, next))
    session = next
  }
  return { session, lines }
}

const ACTIVATED = {
  type: 'activated',
  generationDirectory: '/Users/someone/Library/Caches/gen-1',
  sessionId: 'session-one',
  buildId: MANIFEST.buildId,
  totalBytes: MANIFEST.totalBytes,
  elapsedMs: 1234
} as const

const DOWNLOAD_OPEN: readonly Pending[] = [
  { type: 'gates-changed', gates: gates() },
  { type: 'cache-read', generation: null },
  { type: 'manifest-read', manifest: MANIFEST },
  {
    type: 'fetch-progress',
    completedAssets: 1,
    totalAssets: MANIFEST.totalAssets,
    receivedBytes: 10,
    totalBytes: MANIFEST.totalBytes
  },
  {
    type: 'fetch-progress',
    completedAssets: 2,
    totalAssets: MANIFEST.totalAssets,
    receivedBytes: 20,
    totalBytes: MANIFEST.totalBytes
  },
  { type: 'download-staged' },
  ACTIVATED
]

function present(line: ShellLifecycleLine | null): ShellLifecycleLine[] {
  expect(line).not.toBeNull()
  return line === null ? [] : [line]
}

function summary(lines: readonly ShellLifecycleLine[]): string[] {
  return lines.map(
    (line) => `${line.code} ${line.message}${line.detail ? ` | ${line.detail}` : ''}`
  )
}

describe('shell lifecycle log lines', () => {
  it('logs each state change of a download open once, and no progress ticks', () => {
    const { lines } = replay(DOWNLOAD_OPEN)
    const build = MANIFEST.buildId.slice(0, 8)
    expect(summary(lines)).toEqual([
      `web-shell-flow Web shell: downloading app | ${MANIFEST.totalAssets} assets, ${MANIFEST.totalBytes} bytes`,
      'web-shell-flow Web shell: activating app | source=download',
      `web-shell-flow Web shell: app opened | source=download build=${build} elapsed=1234ms`
    ])
    // The generation directory names a device path and never reaches the log.
    expect(JSON.stringify(lines)).not.toContain('/Users/someone')
  })

  it('logs nothing for a route that stays native, the normal case for native screens', () => {
    const { session, lines } = replay([
      { type: 'gates-changed', gates: gates({ hostCapabilities: [] }) }
    ])
    expect(session.state.kind).toBe('native-route')
    expect(lines).toEqual([])
  })

  it('logs a cache open with its source', () => {
    const { lines } = replay([
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: CACHED },
      { type: 'manifest-read', manifest: MANIFEST },
      ACTIVATED
    ])
    expect(summary(lines)).toEqual([
      expect.stringContaining('Web shell: app opened | source=cache build=')
    ])
  })

  it('logs the first page signals of a document and drops their repeats', () => {
    const opened = replay(DOWNLOAD_OPEN).session
    const { lines } = replay(
      [
        { type: 'document-started' },
        { type: 'document-loaded' },
        { type: 'page-ready' },
        { type: 'page-ready' },
        { type: 'page-painted' },
        { type: 'page-painted' },
        { type: 'page-back-claim', claimed: true }
      ],
      opened
    )
    expect(summary(lines)).toEqual([
      'web-shell-page Web shell: page document loaded',
      'web-shell-page Web shell: page ready',
      'web-shell-page Web shell: page painted'
    ])
  })

  it('logs a missed ready deadline, the failure it causes and the recovery flow', () => {
    const opened = replay(DOWNLOAD_OPEN).session
    const { lines } = replay([{ type: 'document-loaded' }, { type: 'page-ready-deadline' }], opened)
    expect(summary(lines)).toEqual([
      'web-shell-page Web shell: page document loaded',
      'web-shell-page Web shell: page never said ready before the deadline',
      'web-shell-flow Web shell: checking host'
    ])
  })

  it('logs a view failure reported by the native view and the remount it earns', () => {
    const opened = replay(DOWNLOAD_OPEN).session
    const { lines } = replay(
      [
        { type: 'shell-failed', reason: 'render-process-gone' },
        { type: 'remounted', sessionId: 'session-two' }
      ],
      opened
    )
    expect(summary(lines)).toEqual([
      'web-shell-page Web shell: page load failed | reason=render-process-gone',
      'web-shell-flow Web shell: page view remounted'
    ])
  })

  it('ignores results from a superseded flow', () => {
    const opened = replay(DOWNLOAD_OPEN).session
    const { lines } = replay(
      [
        { type: 'page-ready-deadline', flow: opened.flow - 1 },
        { ...ACTIVATED, flow: 0 }
      ],
      opened
    )
    expect(lines).toEqual([])
  })

  it('logs a failed download with its closed reason code', () => {
    const { lines } = replay([
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: null },
      { type: 'download-failed', cause: { reason: 'connection-lost', hostCode: null } }
    ])
    expect(summary(lines)).toEqual([
      'web-shell-flow Web shell: app download failed | reason=connection-lost',
      'web-shell-flow Web shell: failed | reason=download-failed retried=no'
    ])
  })

  it('names a stall only for the two states that read "Opening workspace"', () => {
    expect(
      shellStallLine(
        { kind: 'activating', source: 'download' },
        {
          pageReady: false,
          pagePainted: false
        }
      )
    ).toMatchObject({ code: 'web-shell-stalled', detail: 'source=download' })
    const ready = replay(DOWNLOAD_OPEN).session
    expect(shellStallLine(ready.state, { pageReady: true, pagePainted: false })).toMatchObject({
      code: 'web-shell-stalled',
      message: 'Web shell: page has not drawn after 15s',
      detail: 'page ready=yes'
    })
    expect(shellStallLine(ready.state, { pageReady: true, pagePainted: true })).toBeNull()
    expect(
      shellStallLine({ kind: 'checking' }, { pageReady: false, pagePainted: false })
    ).toBeNull()
  })

  it('keeps device paths out of a page fault and skips routine bridge kinds', () => {
    const fault = pageFaultLine({
      category: 'TypeError',
      message: 'x is undefined at file:///var/mobile/app/index.js:1\n    at /Users/me/secret.js',
      isRpcDeliveryUnknown: false
    })
    expect(fault.detail).toBe('TypeError: x is undefined at [path]')
    expect(
      bridgeDiagnosticLine({
        kind: 'terminal-backlog',
        id: 't',
        coalescedFrames: 0,
        deliveredFrames: 0,
        peakPendingBytes: 0,
        ended: null
      })
    ).toBeNull()
    expect(
      bridgeDiagnosticLine({ kind: 'notify-refused', name: 'fault', why: 'ungranted' })
    ).toEqual({
      level: 'warn',
      code: 'web-shell-bridge',
      message: 'Web shell bridge: notify-refused',
      detail: 'ungranted'
    })
  })
})

describe('shell lifecycle lines in the exported report', () => {
  function entries(lines: readonly ShellLifecycleLine[]): ConnectionLogEntry[] {
    return lines.map((line, index) => ({ id: `e${index}`, ts: 1_000 + index * 1_000, ...line }))
  }

  it('shows where a connected session stalled without changing the connection verdict', () => {
    const opened = replay(DOWNLOAD_OPEN)
    const page = replay(
      [{ type: 'document-started' }, { type: 'document-loaded' }, { type: 'page-ready' }],
      opened.session
    )
    const stall = present(shellStallLine(page.session.state, page.session))
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Desk',
      endpoint: 'ws://192.168.1.2:6768',
      state: 'connected',
      reconnectAttempts: 0,
      lastConnectedAt: 500,
      platform: 'ios',
      appVersion: '0.0.56',
      entries: entries([...opened.lines, ...page.lines, ...stall]),
      nowMs: 60_000
    })
    expect(report).toContain('Likely cause: Connection is healthy.')
    expect(report).toContain('[web-shell-flow] Web shell: app opened')
    expect(report).toContain('[web-shell-page] Web shell: page ready')
    expect(report).toContain(
      '[warn] [web-shell-stalled] Web shell: page has not drawn after 15s — page ready=yes'
    )
  })

  it('never reads shell lines as a connection failure', () => {
    const failed = replay([
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: null },
      { type: 'download-failed', cause: { reason: 'connection-lost', hostCode: null } }
    ])
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Desk',
      endpoint: 'ws://192.168.1.2:6768',
      state: 'disconnected',
      reconnectAttempts: 1,
      lastConnectedAt: null,
      platform: 'ios',
      appVersion: '0.0.56',
      entries: entries([
        ...failed.lines,
        ...present(shellStallLine({ kind: 'activating', source: 'download' }, failed.session)),
        ...present(bridgeDiagnosticLine({ kind: 'refused', refusal: 'oversized' }))
      ]),
      nowMs: 60_000
    })
    expect(report).toContain(
      'Likely cause: No single failure cause can be determined from the recorded events.'
    )
  })

  it('leaves an earlier connection failure as the likely cause', () => {
    const timeout: ConnectionLogEntry = {
      id: 'timeout',
      ts: 500,
      level: 'error',
      code: 'connect-timeout',
      message: 'WebSocket connect timeout'
    }
    const report = buildConnectionDiagnosticsReport({
      hostName: 'Desk',
      endpoint: 'ws://192.168.1.2:6768',
      state: 'disconnected',
      reconnectAttempts: 1,
      lastConnectedAt: null,
      platform: 'ios',
      appVersion: '0.0.56',
      entries: [timeout, ...entries(replay(DOWNLOAD_OPEN).lines)],
      nowMs: 60_000
    })
    expect(report).toContain(
      'Likely cause: The saved direct endpoint did not answer before the connection timeout.'
    )
  })
})
