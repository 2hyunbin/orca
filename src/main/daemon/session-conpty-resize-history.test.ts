import { afterEach, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import type { PtyOwnerBackend } from '../../shared/pty-owner-backend'
import { buildFreshShellViewportBlankingSequence } from '../../shared/terminal-fresh-shell-viewport'
import { PROCESS_BOUNDARY_GROUND } from '../../shared/terminal-mode-reset-profiles'
import { Session } from './session'

const COLS = 119
const ROWS = 58
const PROMPT = 'orca@awin:~/projects/p8/deep$ '
const RESTORED = `${Array.from({ length: 6 }, (_, i) => `${PROMPT}echo L${i}\r\nL${i}`).join('\r\n')}\r\n${PROMPT}echo PRESLEEP\r\nPRESLEEP\r\n${PROMPT}`
// The fresh shell's rows, which are all ConPTY knows about.
const SHELL_ROWS = [PROMPT, `${PROMPT}echo WAKE`, 'WAKE', PROMPT]

function createMockSubprocess() {
  let onData: ((data: string) => void) | null = null
  return {
    pid: 12345,
    getForegroundProcess: (): string | null => null,
    write(_data: string) {},
    resize(_cols: number, _rows: number) {},
    kill() {},
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill() {},
    signal(_sig: string) {},
    onData(cb: (data: string) => void) {
      onData = cb
    },
    onExit(_cb: (code: number) => void) {},
    dispose() {},
    simulateData(data: string) {
      onData?.(data)
    }
  }
}

let session: Session | null = null

afterEach(() => {
  session?.dispose()
  session = null
})

async function renderRows(ansi: string): Promise<string[]> {
  const terminal = new Terminal({
    cols: COLS,
    rows: ROWS,
    scrollback: 5000,
    allowProposedApi: true
  })
  await new Promise<void>((resolve) => terminal.write(ansi, resolve))
  const rows: string[] = []
  for (let i = 0; i < terminal.buffer.active.length; i++) {
    rows.push(terminal.buffer.active.getLine(i)?.translateToString(true) ?? '')
  }
  terminal.dispose()
  return rows
}

async function checkpointAfterRelaunchResize(ownerBackend: PtyOwnerBackend): Promise<string[]> {
  const subprocess = createMockSubprocess()
  session = new Session({
    sessionId: 'conpty-resize',
    cols: COLS,
    rows: ROWS,
    subprocess,
    shellReadySupported: false,
    ownerBackend,
    historySeedChunks: [
      RESTORED,
      PROCESS_BOUNDARY_GROUND,
      buildFreshShellViewportBlankingSequence(ROWS)
    ]
  })
  subprocess.simulateData(SHELL_ROWS.join('\r\n'))
  // A relaunched window's first attach shrinks the grid, then fits it back.
  session.resize(COLS, 2)
  session.resize(COLS, ROWS)
  // ConPTY then repaints the grid it owns from the top.
  const repaint = Array.from({ length: ROWS }, (_, i) => `${SHELL_ROWS[i] ?? ''}\x1b[K`)
  subprocess.simulateData(
    `\x1b[H${repaint.join('\r\n')}\x1b[${SHELL_ROWS.length};${PROMPT.length + 1}H`
  )
  await session.settleShellOwnershipConfirmation()
  const snapshot = session.takePendingOutput(true, { teardownSnapshot: true })?.snapshot
  expect(snapshot).toBeTruthy()
  return renderRows(`${snapshot!.rehydrateSequences}${snapshot!.snapshotAnsi}`)
}

describe('daemon checkpoint after a relaunch resize under ConPTY', () => {
  it('keeps restored history and the fresh-shell padding when ConPTY repaints', async () => {
    const rows = await checkpointAfterRelaunchResize('windows-wsl')
    const text = rows.join('\n')
    expect(text.match(/^L\d$/gm)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5'])
    expect(text).toContain('PRESLEEP')
    const restoredPrompt = rows.indexOf('PRESLEEP') + 1
    // The restored prompt stays alone on its row, padded away from the new shell's rows.
    expect(rows[restoredPrompt]?.trimEnd()).toBe(PROMPT.trimEnd())
    expect(rows.slice(restoredPrompt + 1, restoredPrompt + 30).every((row) => row === '')).toBe(
      true
    )
    expect(rows.filter((row) => row.split(PROMPT.trimEnd()).length > 2)).toEqual([])
  })
})
