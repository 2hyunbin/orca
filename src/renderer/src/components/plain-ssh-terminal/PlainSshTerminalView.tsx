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
import { getShortcutPlatform } from '@/lib/shortcut-platform'
import { useEffectiveMacOptionAsAlt } from '@/lib/keyboard-layout/use-effective-mac-option-as-alt'
import { composeActiveTerminalTheme } from '@/components/terminal-pane/terminal-appearance'
import { resolveEffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { TERMINAL_PASTE_MAX_BYTES } from '@/components/terminal-pane/terminal-paste-limits'
import { installPreviewTerminalKeyHandler } from '@/components/dashboard-popout/preview-terminal-key-handler'
import { installPreviewTerminalAppMenuClipboard } from '@/components/dashboard-popout/preview-terminal-app-menu-clipboard'
import { removePlainSshPanel } from '@/ssh/plain-ssh-terminal-panels'

export type PlainSshTerminalPhase =
  | { kind: 'opening' }
  | { kind: 'open' }
  | { kind: 'failed'; message: string }
  | { kind: 'ended'; exitCode: number; signal?: number }

/** Output ssh may print before the open reply lands; more than this is never a login banner. */
const EARLY_EVENT_LIMIT = 256

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
        'Another Orca window already has a plain SSH terminal open to this host.'
      )
    case 'cancelled':
      return translate(
        'auto.components.plainSshTerminal.cancelled',
        'This plain SSH terminal was closed before it started.'
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
  const macOptionAsAlt = useEffectiveMacOptionAsAlt(settings?.terminalMacOptionAsAlt)
  const [initial] = useState(() => ({ settings, systemPrefersDark, macOptionAsAlt }))
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
    let phase: 'opening' | 'open' | 'done' = 'opening'
    let disposed = false
    const early: PlainSshTerminalEvent[] = []
    let unsubscribe: () => void = () => {}
    const finish = (next: PlainSshTerminalPhase | null): void => {
      phase = 'done'
      sessionId = null
      early.length = 0
      unsubscribe()
      if (next) {
        onPhaseRef.current(next)
      }
    }
    const handle = (event: PlainSshTerminalEvent): void => {
      if (event.kind === 'data') {
        terminal.write(event.data)
        return
      }
      // A clean logout closes the window; anything else keeps its output, with no shell after it.
      const clean = event.exitCode === 0 && !event.signal
      finish(clean ? null : { kind: 'ended', exitCode: event.exitCode, signal: event.signal })
      if (clean) {
        removePlainSshPanel(targetId)
      }
    }
    unsubscribe = api.onEvent((event) => {
      if (phase === 'opening') {
        // Why: ssh can print before the open reply lands; hold a bounded amount until the id is known.
        if (early.length < EARLY_EVENT_LIMIT) {
          early.push(event)
        }
      } else if (phase === 'open' && event.sessionId === sessionId) {
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
          finish({ kind: 'failed', message: plainSshOpenFailureText(result) })
          return
        }
        sessionId = result.sessionId
        phase = 'open'
        onPhaseRef.current({ kind: 'open' })
        for (const event of early.splice(0)) {
          if (phase === 'open' && event.sessionId === result.sessionId) {
            handle(event)
          }
        }
        terminal.focus()
      })
      .catch((error: unknown) => {
        if (!disposed) {
          finish({
            kind: 'failed',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })

    const pasteClipboardText = async (activeElement: Element | null): Promise<void> => {
      const text = await window.api.ui
        .readClipboardText({ maxBytes: TERMINAL_PASTE_MAX_BYTES })
        .catch(() => '')
      if (text && !disposed && activeElement && container.contains(activeElement)) {
        // Why paste, not write: xterm adds bracketed-paste markers when the remote shell asked.
        terminal.paste(text)
      }
    }
    // Same copy, paste and shortcut policy as Orca's other standalone terminals.
    const disposeKeyHandler = installPreviewTerminalKeyHandler({
      terminal,
      claimImeKeyEvent: () => false,
      pasteClipboardText: (activeElement) => void pasteClipboardText(activeElement),
      sendInput: (data) => terminal.input(data),
      getShortcutContext: () => ({
        clientPlatform: getShortcutPlatform(),
        macOptionAsAlt: initial.macOptionAsAlt,
        keybindings: useAppStore.getState().keybindings,
        terminalInput: null,
        getKittyKeyboardFlags: () => 0,
        terminalShortcutPolicy: useAppStore.getState().settings?.terminalShortcutPolicy
      })
    })
    const disposeAppMenuClipboard = installPreviewTerminalAppMenuClipboard({
      container,
      getTerminal: () => terminal,
      pasteClipboardText: (activeElement) => void pasteClipboardText(activeElement)
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
      disposeKeyHandler()
      disposeAppMenuClipboard()
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
