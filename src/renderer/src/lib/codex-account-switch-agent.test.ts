import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { CodexManagedAccount } from '../../../shared/managed-account-types'
import type * as localPreflightContext from '@/lib/local-preflight-context'
import type * as paneSelectionLane from './codex-pane-selection-lane'
import type * as rendererAppPlatform from './renderer-app-platform'
import {
  confirmRuntimeTerminalForegroundProcess,
  inspectRuntimeTerminalProcess
} from '@/runtime/runtime-terminal-inspection'
import {
  CODEX_ACCOUNT_SWITCH_AGENT,
  resolveCodexSessionAccountId
} from './codex-account-switch-agent'
import {
  findMovableAgentSessions,
  findQueuedAccountRestartsOnAccount
} from './agent-account-switch-discovery'
import { ptyId, seedAgentPanes, type SeededAgentPane } from './agent-account-switch-test-panes'

const laneByPtyId = vi.hoisted((): Record<string, string> => ({}))
const platform = vi.hoisted((): { current: NodeJS.Platform } => ({ current: 'darwin' }))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(),
  confirmRuntimeTerminalForegroundProcess: vi.fn()
}))
vi.mock('@/lib/local-preflight-context', async (importOriginal) => ({
  ...(await importOriginal<typeof localPreflightContext>()),
  getLocalProjectExecutionRuntimeContext: () => undefined
}))
vi.mock('./renderer-app-platform', async (importOriginal) => ({
  ...(await importOriginal<typeof rendererAppPlatform>()),
  getRendererAppPlatform: () => platform.current
}))
vi.mock('./codex-pane-selection-lane', async (importOriginal) => ({
  ...(await importOriginal<typeof paneSelectionLane>()),
  resolveCodexPaneSelectionLane: ({ ptyId: id }: { ptyId: string }) => ({
    laneKey: laneByPtyId[id] ?? 'host',
    source: 'derived',
    derivedLaneKey: null
  })
}))

const LOCAL = { kind: 'local' } as const
const HOST = { runtime: 'host' } as const
const USER_DATA = '/Users/dev/Library/Application Support/orca'
const HOME_A = `${USER_DATA}/codex-accounts/acct-a/home`
const HOME_B = `${USER_DATA}/codex-accounts/acct-b/home`
const SYSTEM_HOME = '/Users/dev/.codex'
const LEGACY_SHARED_HOME = `${USER_DATA}/codex-runtime-home/home`
const WSL_LINUX_HOME = '/home/dev/.local/share/orca/codex-accounts/acct-w/home'

function account(id: string, managedHomePath: string, extra: Partial<CodexManagedAccount> = {}) {
  return {
    id,
    email: `${id}@example.com`,
    managedHomePath,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    ...extra
  }
}

const ACCOUNTS: CodexManagedAccount[] = [
  account('acct-a', HOME_A),
  account('acct-b', HOME_B),
  account(
    'acct-w',
    '\\\\wsl.localhost\\Ubuntu\\home\\dev\\.local\\share\\orca\\codex-accounts\\acct-w\\home',
    {
      managedHomeRuntime: 'wsl',
      wslDistro: 'Ubuntu',
      wslLinuxHomePath: WSL_LINUX_HOME
    }
  )
]
const rollout = (home: string): string => `${home}/sessions/2026/10/17/rollout-s.jsonl`

function seedCodexPanes(panes: (Omit<SeededAgentPane, 'transcriptPath'> & { home: string })[]) {
  seedAgentPanes(
    panes.map(({ home, ...pane }) => ({
      agentType: 'codex',
      launchAgent: 'codex',
      ...pane,
      transcriptPath: rollout(home)
    })),
    { codexManagedAccounts: ACCOUNTS }
  )
}

const movable = async (
  fromAccountId: string | null,
  target: { runtime: 'host' | 'wsl'; wslDistro?: string } = HOST
) =>
  (
    await findMovableAgentSessions(CODEX_ACCOUNT_SWITCH_AGENT, {
      owner: LOCAL,
      target,
      fromAccountId
    })
  ).map((pane) => pane.ptyId)

beforeEach(() => {
  platform.current = 'darwin'
  for (const key of Object.keys(laneByPtyId)) {
    delete laneByPtyId[key]
  }
  vi.mocked(inspectRuntimeTerminalProcess).mockResolvedValue({
    foregroundProcess: 'codex',
    hasChildProcesses: true
  })
  vi.mocked(confirmRuntimeTerminalForegroundProcess).mockResolvedValue('codex')
})

describe('resolveCodexSessionAccountId', () => {
  const resolve = (transcriptPath: string | undefined, sourceHome?: { host?: string }) =>
    resolveCodexSessionAccountId(transcriptPath, ACCOUNTS, sourceHome)

  it("reads a saved account from its own home's sessions folder", () => {
    expect(resolve(rollout(HOME_A))).toBe('acct-a')
    expect(resolve(rollout(WSL_LINUX_HOME))).toBe('acct-w')
  })

  it('reads ~/.codex and a configured history home as System default', () => {
    expect(resolve(rollout(SYSTEM_HOME))).toBeNull()
    expect(resolve(rollout('/home/dev/.codex'))).toBeNull()
    expect(resolve(rollout('/work/codex-home'), { host: '/work/codex-home/' })).toBeNull()
  })

  it("cannot tell the account of Orca's retired shared home or a missing transcript", () => {
    expect(resolve(rollout(LEGACY_SHARED_HOME))).toBeUndefined()
    expect(resolve(rollout('/work/codex-home'))).toBeUndefined()
    expect(resolve(undefined)).toBeUndefined()
  })

  it('matches Windows paths whatever their case and separators', () => {
    platform.current = 'win32'
    const windowsAccounts = [account('acct-x', 'C:\\Users\\Dev\\AppData\\orca\\acct-x\\home')]
    expect(
      resolveCodexSessionAccountId(
        'c:\\users\\dev\\appdata\\ORCA\\acct-x\\home\\sessions\\2026\\rollout-s.jsonl',
        windowsAccounts
      )
    ).toBe('acct-x')
  })
})

describe('finding Codex sessions to move', () => {
  it('offers only the sessions on the account the switch left', async () => {
    seedCodexPanes([
      { n: 1, home: HOME_A },
      { n: 2, home: HOME_B },
      { n: 3, home: SYSTEM_HOME },
      { n: 4, home: LEGACY_SHARED_HOME },
      { n: 5, agentType: 'claude', home: HOME_A }
    ])

    expect(await movable('acct-a')).toEqual([ptyId(1)])
    expect(await movable(null)).toEqual([ptyId(3)])
  })

  it('offers nothing when switching back to the account the sessions still run on', async () => {
    seedCodexPanes([{ n: 1, home: HOME_A }])

    // A→B left the session on A; B→A finds nothing on B to move.
    expect(await movable('acct-b')).toEqual([])
  })

  it('finds a WSL session from its Linux home, only on its own distro', async () => {
    seedCodexPanes([
      { n: 1, home: WSL_LINUX_HOME },
      { n: 2, home: HOME_A }
    ])
    laneByPtyId[ptyId(1)] = 'wsl:Ubuntu'

    expect(await movable('acct-w', { runtime: 'wsl', wslDistro: 'Ubuntu' })).toEqual([ptyId(1)])
    expect(await movable('acct-w', { runtime: 'wsl', wslDistro: 'Debian' })).toEqual([])
    expect(await movable('acct-w')).toEqual([])
  })

  it('never offers a session on a remote server switch', async () => {
    seedCodexPanes([{ n: 1, home: HOME_A }])

    expect(
      await findMovableAgentSessions(CODEX_ACCOUNT_SWITCH_AGENT, {
        owner: { kind: 'environment', environmentId: 'env-1' },
        target: HOST,
        fromAccountId: 'acct-a'
      })
    ).toEqual([])
  })

  it('recognizes codex.exe and re-checks a shell reading before skipping a pane', async () => {
    seedCodexPanes([
      { n: 1, home: HOME_A },
      { n: 2, home: HOME_A },
      { n: 3, home: HOME_A }
    ])
    vi.mocked(inspectRuntimeTerminalProcess).mockImplementation(async (id) =>
      id === ptyId(1)
        ? { foregroundProcess: 'codex.exe', hasChildProcesses: true }
        : { foregroundProcess: 'zsh', hasChildProcesses: false }
    )
    // The cached read flaps to the shell for pane 2; pane 3 really exited Codex.
    vi.mocked(confirmRuntimeTerminalForegroundProcess).mockImplementation(async (id) =>
      id === ptyId(2) ? 'codex' : 'zsh'
    )

    expect(await movable('acct-a')).toEqual([ptyId(1), ptyId(2)])
  })
})

describe('queued Codex restarts already on the account', () => {
  it('lists queued restarts whose session runs on the newly selected account', () => {
    seedCodexPanes([
      { n: 1, home: HOME_B },
      { n: 2, home: HOME_A },
      { n: 3, home: LEGACY_SHARED_HOME }
    ])
    useAppStore.setState({
      pendingPaneAccountRestarts: { [ptyId(1)]: 'codex', [ptyId(2)]: 'codex', [ptyId(3)]: 'codex' }
    })

    expect(
      findQueuedAccountRestartsOnAccount(CODEX_ACCOUNT_SWITCH_AGENT, {
        owner: LOCAL,
        target: HOST,
        accountId: 'acct-b'
      })
    ).toEqual([ptyId(1)])
  })
})
