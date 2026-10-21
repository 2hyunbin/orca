import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type {
  PlainSshTerminalEvent,
  PlainSshTerminalOpenResult
} from '../../../../shared/plain-ssh-terminal'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { buildDefaultTerminalOptions } from '@/lib/pane-manager/pane-terminal-options'
import { buildFontFamily } from '@/lib/monospace-font-family'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { removePlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'

export type PlainSshTerminalPhase =
  | { kind: 'opening' }
  | { kind: 'open' }
  | { kind: 'failed'; message: string }
  | { kind: 'ended'; exitCode: number }

export function plainSshOpenFailureText(
  result: Extract<PlainSshTerminalOpenResult, { ok: false }>
): string {
  switch (result.reason) {
    case 'unknown-target':
      return translate(
        'auto.components.plainSshTerminal.unknownTarget',
        'This SSH host is no longer saved in Orca.'
      )
    case 'not-blocked':
      return translate(
        'auto.components.plainSshTerminal.notBlocked',
        'Orca can reach this host again, so use its terminals instead. Plain SSH is only for while Orca can’t set up on the host.'
      )
    case 'already-open':
      return translate(
        'auto.components.plainSshTerminal.alreadyOpen',
        'A plain SSH terminal to this host is already open.'
      )
    case 'ssh-missing':
    case 'spawn-failed':
      return result.message
  }
}

/** One plain SSH session; it starts on mount and hangs up on unmount. */
export function PlainSshTerminalView({
  targetId,
  hidden,
  onPhase
}: {
  targetId: string
  hidden: boolean
  onPhase: (phase: PlainSshTerminalPhase) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const settings = useAppStore((s) => s.settings)
  const systemPrefersDark = useSystemPrefersDark()
  const [initial] = useState(() => ({ settings, systemPrefersDark }))
  const onPhaseRef = useRef(onPhase)
  useEffect(() => {
    onPhaseRef.current = onPhase
  }, [onPhase])

  useEffect(() => {
    const container = containerRef.current
    const api = window.api.plainSsh
    if (!container || !api) {
      return
    }
    const base = initial.settings
    const theme = base
      ? composeActiveTerminalTheme(
          resolveEffectiveTerminalAppearance(base, initial.systemPrefersDark).theme,
          base
        )
      : undefined
    const terminal = new Terminal({
      ...buildDefaultTerminalOptions(),
      ...(base
        ? { fontSize: base.terminalFontSize, fontFamily: buildFontFamily(base.terminalFontFamily) }
        : {}),
      theme: theme ?? undefined
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(container)
    terminalRef.current = terminal
    fitRef.current = fit
    fit.fit()

    let sessionId: string | null = null
    let disposed = false
    // Why: ssh can print before the open reply lands; hold its output until the id is known.
    const early: PlainSshTerminalEvent[] = []
    const handle = (event: PlainSshTerminalEvent): void => {
      if (event.kind === 'data') {
        terminal.write(event.data)
        return
      }
      sessionId = null
      if (event.exitCode === 0) {
        removePlainSshPanel(targetId)
      } else {
        onPhaseRef.current({ kind: 'ended', exitCode: event.exitCode })
      }
    }
    const unsubscribe = api.onEvent((event) => {
      if (sessionId === null) {
        early.push(event)
      } else if (event.sessionId === sessionId) {
        handle(event)
      }
    })
    void api
      .open({ targetId, cols: terminal.cols, rows: terminal.rows })
      .then((result) => {
        if (disposed) {
          if (result.ok) {
            api.close({ sessionId: result.sessionId })
          }
          return
        }
        if (!result.ok) {
          onPhaseRef.current({ kind: 'failed', message: plainSshOpenFailureText(result) })
          return
        }
        sessionId = result.sessionId
        onPhaseRef.current({ kind: 'open' })
        for (const event of early.splice(0)) {
          if (event.sessionId === result.sessionId) {
            handle(event)
          }
        }
        terminal.focus()
      })
      .catch((error: unknown) => {
        if (!disposed) {
          onPhaseRef.current({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    const dataListener = terminal.onData((data) => {
      if (sessionId) {
        api.write({ sessionId, data })
      }
    })
    const resizeListener = terminal.onResize(({ cols, rows }) => {
      if (sessionId) {
        api.resize({ sessionId, cols, rows })
      }
    })
    const observer = new ResizeObserver(() => {
      if (container.offsetWidth > 0 && container.offsetHeight > 0) {
        fit.fit()
      }
    })
    observer.observe(container)
    return () => {
      disposed = true
      observer.disconnect()
      dataListener.dispose()
      resizeListener.dispose()
      unsubscribe()
      if (sessionId) {
        api.close({ sessionId })
      }
      terminal.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [initial, targetId])

  useEffect(() => {
    if (!hidden) {
      fitRef.current?.fit()
      terminalRef.current?.focus()
    }
  }, [hidden])

  return <div ref={containerRef} className="size-full min-h-0 overflow-hidden px-2 py-1" />
}
