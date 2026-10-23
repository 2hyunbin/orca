import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { collectWslMoveGateInputs, type WslMoveGateFactSources } from './wsl-move-gate-facts'
import {
  classifyWslGuestPaneForeground,
  parseWslGuestPaneProcesses,
  WSL_GUEST_PANE_PROCESS_SCRIPT,
  type WslGuestProcessRow
} from './wsl-move-guest-foreground'
import { assessWslMoveTerminals } from './wsl-move-terminal-gate'

const WT = 'repo-1::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const KEY_A = 'tab-1:11111111-1111-4111-8111-111111111111'
const KEY_B = 'tab-2:22222222-1111-4111-8111-111111111111'
const scope = { workspaceIds: [WT], workspaceKeys: new Set([WT]) }

const proc = (
  pid: number,
  pgrp: number,
  tpgid: number,
  comm: string,
  paneKey: string | null
): WslGuestProcessRow => ({ pid, pgrp, tpgid, comm, paneKey })

describe('classifyWslGuestPaneForeground', () => {
  it('reads a pane whose foreground group is only its shell as idle', () => {
    const rows = [proc(100, 100, 100, 'bash', KEY_A), proc(200, 200, 205, 'bash', KEY_B)]
    expect(classifyWslGuestPaneForeground(rows, KEY_A)).toBe('shell-idle')
  })

  it('reads a running program as busy, even one that cleared its environment', () => {
    const rows = [
      proc(100, 100, 150, 'bash', KEY_A),
      proc(150, 150, 150, 'vim', null),
      proc(200, 200, 200, 'zsh', KEY_B)
    ]
    expect(classifyWslGuestPaneForeground(rows, KEY_A)).toBe('process-running')
    expect(classifyWslGuestPaneForeground(rows, KEY_B)).toBe('shell-idle')
  })

  it('never reads a pane with no guest process, or an ambiguous terminal, as idle', () => {
    expect(classifyWslGuestPaneForeground([], KEY_A)).toBe('unverifiable')
    const split = [proc(100, 100, 100, 'bash', KEY_A), proc(300, 300, 300, 'bash', KEY_A)]
    expect(classifyWslGuestPaneForeground(split, KEY_A)).toBe('unverifiable')
  })
})

describe('parseWslGuestPaneProcesses', () => {
  it('keeps comm with spaces and drops malformed lines', () => {
    expect(
      parseWslGuestPaneProcesses(`10\t10\t10\tmy prog\t${KEY_A}\nbad line\n11\t11\t11\tbash\t\n`)
    ).toEqual([proc(10, 10, 10, 'my prog', KEY_A), proc(11, 11, 11, 'bash', null)])
  })
})

describe.runIf(process.platform === 'linux')('WSL_GUEST_PANE_PROCESS_SCRIPT on Linux', () => {
  it('lists processes as pid, pgrp, tpgid, comm and pane key', () => {
    const out = execFileSync('sh', ['-c', WSL_GUEST_PANE_PROCESS_SCRIPT], { encoding: 'utf8' })
    for (const row of parseWslGuestPaneProcesses(out)) {
      expect(row.pid).toBeGreaterThan(0)
    }
  })
})

describe('collectWslMoveGateInputs with a guest foreground reader', () => {
  // The Windows host sees `wsl.exe` under every live bridge pane: this is what it reported on awin.
  const windowsSaysLive: WslMoveGateFactSources['inspect'] = async () => ({
    foregroundProcess: 'wsl.exe',
    hasChildProcesses: true,
    childProcessEvidence: 'children'
  })
  const base: WslMoveGateFactSources = {
    listTerminals: () => [
      { ptyId: 'pty-1', workspaceId: WT, paneKey: KEY_A, wslDistro: 'Ubuntu', foregroundAgent: null }
    ],
    inspect: windowsSaysLive,
    agentRows: () => [],
    scrollbackBytes: async () => 10,
    automationRuns: () => [],
    dispatches: () => []
  }

  it('passes an idle bridge shell the Windows host reads as running wsl.exe', async () => {
    const inputs = await collectWslMoveGateInputs(
      { ...base, guestForegrounds: async () => new Map([[KEY_A, 'shell-idle']]) },
      scope
    )
    expect(inputs.panes[0]?.foreground).toBe('shell-idle')
    expect(assessWslMoveTerminals(inputs).verdict).toBe('ready')
  })

  it('still blocks a real guest program, and a guest that cannot be read', async () => {
    const busy = await collectWslMoveGateInputs(
      { ...base, guestForegrounds: async () => new Map([[KEY_A, 'process-running']]) },
      scope
    )
    expect(assessWslMoveTerminals(busy).verdict).toBe('blocked')
    const failed = await collectWslMoveGateInputs(
      {
        ...base,
        guestForegrounds: async () => {
          throw new Error('wsl_unavailable')
        }
      },
      scope
    )
    expect(failed.panes[0]?.foreground).toBe('unverifiable')
  })
})
