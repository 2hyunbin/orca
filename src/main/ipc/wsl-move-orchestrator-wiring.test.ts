import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WSL_HOSTS_INTERNAL_GATE_ENV } from '../../shared/wsl-host-internal-gate'
import { WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL } from '../../shared/wsl-move/wsl-move-orchestrator-types'

type Handler = (event: unknown, request?: unknown) => unknown

const handlers = vi.hoisted(() => new Map<string, Handler>())
const sent = vi.hoisted((): { channel: string; payload: unknown }[] => [])
vi.mock('electron', () => ({
  app: { getPath: () => '/user-data', getVersion: () => '1.0.0' },
  ipcMain: {
    removeHandler: (channel: string) => handlers.delete(channel),
    handle: (channel: string, handler: Handler) => handlers.set(channel, handler)
  }
}))
const MAIN_WINDOW_ID = 7
vi.mock('./ui', () => {
  const webContents = {
    id: MAIN_WINDOW_ID,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload })
  }
  return {
    getTrustedUIRendererWebContents: () => webContents,
    getTrustedUIRendererWindow: () => ({ isDestroyed: () => false, webContents })
  }
})
type Status = { distro: string; state: string; environmentId: string; detail: null }
const host = vi.hoisted(() => ({
  statuses: new Array<Status>(),
  listeners: new Set<() => void>()
}))
vi.mock('../wsl/wsl-host-service-instance', () => ({
  getWslHostService: () => ({
    getStatuses: () => host.statuses,
    onStatusesChanged: (listener: () => void) => {
      host.listeners.add(listener)
      return () => host.listeners.delete(listener)
    }
  })
}))
const driver = vi.hoisted(() => ({
  previewWslMove: vi.fn(async (_deps: unknown, request: { distro: string }) => ({
    outcome: 'ready',
    distro: request.distro,
    repoIds: ['r1'],
    folderWorkspaceIds: [],
    changed: [],
    heldByHost: [],
    refused: [],
    blockers: []
  })),
  moveProjectsToWslHost: vi.fn(async () => ({
    outcome: 'moved',
    migrationId: 'm1',
    phase: 'retained',
    reloadRequired: true
  }))
}))
vi.mock('../persistence/moving-wsl-projects/wsl-move-driver', () => driver)
vi.mock('../persistence/moving-wsl-projects/wsl-move-cutover-journal', () => ({
  listWslMoveCutoverChain: () => []
}))
const store = vi.hoisted(() => ({ reads: 0 }))
vi.mock('../persistence/moving-wsl-projects/wsl-move-orchestrator-store', () => ({
  readWslMoveOrchestratorRecords: () => {
    store.reads++
    return new Map()
  },
  writeWslMoveOrchestratorRecords: () => {}
}))
vi.mock('./wsl-move-handlers', () => ({ releaseWslMovedProjectHere: vi.fn() }))
vi.mock('./wsl-move-undo-wiring', () => ({ createWslMoveUndoPorts: vi.fn() }))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const sleptPanes = [{ paneKey: 'tab:leaf', sessionId: 'wt@@a' }]

function requestIdOf(payload: unknown): string {
  return typeof payload === 'object' &&
    payload !== null &&
    'requestId' in payload &&
    typeof payload.requestId === 'string'
    ? payload.requestId
    : ''
}

async function register(): Promise<void> {
  const { registerWslMoveOrchestrator } = await import('./wsl-move-orchestrator-wiring')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The driver is mocked; the wiring only passes deps through.
  registerWslMoveOrchestrator({} as never, () => ({ now: () => new Date(0) }) as never)
}

/** Answers every slept-pane request the window has been sent. */
async function answerWindow(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) {
    for (const message of sent.splice(0)) {
      if (message.channel === WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL) {
        const requestId = requestIdOf(message.payload)
        await handlers.get('wslMoveOrchestrator:answerSleptPanes')?.(
          { sender: { id: MAIN_WINDOW_ID } },
          { requestId, sleptPanes }
        )
      }
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
}

beforeEach(() => {
  vi.resetModules()
  handlers.clear()
  sent.length = 0
  host.statuses = []
  host.listeners.clear()
  store.reads = 0
  driver.previewWslMove.mockClear()
  driver.moveProjectsToWslHost.mockClear()
})
afterEach(() => vi.unstubAllEnvs())

describe('WSL move orchestrator wiring', () => {
  it('stays dark with the gate closed: nothing read, nothing listed', async () => {
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    expect(store.reads).toBe(0)
    expect(await handlers.get('wslMoveOrchestrator:list')?.({})).toEqual([])
    expect(sent).toEqual([])
  })

  it('moves a distro whose host is ready at start, with the window slept panes', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await answerWindow()
    expect(driver.previewWslMove).toHaveBeenCalledWith(expect.anything(), {
      distro: 'Ubuntu',
      sleptPanes
    })
    expect(driver.moveProjectsToWslHost).toHaveBeenCalledWith(expect.anything(), {
      distro: 'Ubuntu',
      sleptPanes
    })
  })

  it('starts on a host reaching ready, never on one that is not', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    host.statuses = [
      { distro: 'Ubuntu', state: 'connecting', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await answerWindow()
    expect(driver.previewWslMove).not.toHaveBeenCalled()
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    for (const listener of host.listeners) {
      listener()
    }
    await answerWindow()
    expect(driver.moveProjectsToWslHost).toHaveBeenCalledTimes(1)
  })

  it('makes no automatic start with ORCA_WSL_MOVE_AUTO=0', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    vi.stubEnv('ORCA_WSL_MOVE_AUTO', '0')
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    await answerWindow()
    expect(driver.previewWslMove).not.toHaveBeenCalled()
  })

  it('ignores a slept-pane answer from another window', async () => {
    vi.stubEnv(WSL_HOSTS_INTERNAL_GATE_ENV, '1')
    host.statuses = [
      { distro: 'Ubuntu', state: 'ready', environmentId: 'wsl:Ubuntu', detail: null }
    ]
    await register()
    const request = sent.find(
      (message) => message.channel === WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL
    )
    const requestId = requestIdOf(request?.payload)
    await handlers.get('wslMoveOrchestrator:answerSleptPanes')?.(
      { sender: { id: 99 } },
      { requestId, sleptPanes }
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(driver.previewWslMove).not.toHaveBeenCalled()
  })
})
