/**
 * The move orchestrator's production ports and IPC (D3a). Dark: with the internal WSL hosts gate
 * closed, or without a WSL host service, nothing is constructed and the IPC answers empty.
 * Automatic starts also stop when ORCA_WSL_MOVE_AUTO=0; explicit user actions still run.
 */
import { randomUUID } from 'node:crypto'
import { app, ipcMain, type WebContents } from 'electron'
import { WSL_MOVE_CUTOVER_PHASES, wslMoveJournalKey } from '../../shared/wsl-move/wsl-move-cutover'
import type { WslMoveRequest } from '../../shared/wsl-move/wsl-move-driver-types'
import {
  WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL,
  WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL,
  type WslMoveOrchestratorRecord,
  type WslMoveOrchestratorUserAction
} from '../../shared/wsl-move/wsl-move-orchestrator-types'
import type { Store } from '../persistence'
import { listWslMoveCutoverChain } from '../persistence/moving-wsl-projects/wsl-move-cutover-journal'
import {
  moveProjectsToWslHost,
  previewWslMove
} from '../persistence/moving-wsl-projects/wsl-move-driver'
import { wslMovedDistroVerdict } from '../persistence/moving-wsl-projects/wsl-move-moved-distro-check'
import {
  WslMoveOrchestrator,
  type WslMoveFinishedMove,
  type WslMoveHostReadiness
} from '../persistence/moving-wsl-projects/wsl-move-orchestrator'
import { prepareWslMoveHost } from '../persistence/moving-wsl-projects/wsl-move-host-readiness'
import { readConfirmedRunningWslDistros } from '../wsl-background-distro-gate'
import { defaultWslOrcadEnvironmentId } from '../wsl/wsl-orcad-deploy'
import {
  readWslMoveOrchestratorRecords,
  writeWslMoveOrchestratorRecords
} from '../persistence/moving-wsl-projects/wsl-move-orchestrator-store'
import type { WslMoveDriverDeps } from '../persistence/moving-wsl-projects/wsl-move-driver-ports'
import {
  trackWslMoveOrchestrator,
  wslMoveOrchestratorEventProps
} from '../telemetry/wsl-move-orchestrator-telemetry'
import { runTrackedWslMove } from '../telemetry/wsl-move-telemetry'
import { readWslDistroRegistrations } from '../wsl/wsl-distro-registry-id'
import { wslHostsGateOpen } from '../wsl/wsl-host-gate'
import { getWslHostService } from '../wsl/wsl-host-service-instance'
import { getTrustedUIRendererWebContents, getTrustedUIRendererWindow } from './ui'
import { releaseWslMovedProjectHere } from './wsl-move-handlers'
import { createWslMoveUndoPorts } from './wsl-move-undo-wiring'

export const WSL_MOVE_ORCHESTRATOR_AUTO_ENV = 'ORCA_WSL_MOVE_AUTO'

export const WSL_MOVE_ORCHESTRATOR_HANDLER_CHANNELS = [
  'wslMoveOrchestrator:list',
  'wslMoveOrchestrator:projectOpened',
  'wslMoveOrchestrator:userAction',
  'wslMoveOrchestrator:answerSleptPanes'
] as const

const SLEPT_PANES_TIMEOUT_MS = 5_000
const COMMITTED_FROM = WSL_MOVE_CUTOVER_PHASES.indexOf('destination-committed')
const USER_ACTIONS: readonly WslMoveOrchestratorUserAction[] = ['retry', 'not-now', 'restore']

type SleptPanes = NonNullable<WslMoveRequest['sleptPanes']>

const sleptPaneRequests = new Map<string, (panes: SleptPanes | null) => void>()

/** The window's slept-pane bindings, which only it knows; a move without them misses their history. */
function requestSleptPanes(): Promise<SleptPanes> {
  const window = getTrustedUIRendererWindow()
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return Promise.reject(new Error('wsl_move_window_unavailable'))
  }
  const requestId = randomUUID()
  return new Promise<SleptPanes>((resolve, reject) => {
    const timer = setTimeout(() => answer(null), SLEPT_PANES_TIMEOUT_MS)
    function answer(panes: SleptPanes | null): void {
      clearTimeout(timer)
      sleptPaneRequests.delete(requestId)
      if (panes) {
        resolve(panes)
      } else {
        reject(new Error('wsl_move_window_unavailable'))
      }
    }
    sleptPaneRequests.set(requestId, answer)
    window.webContents.send(WSL_MOVE_ORCHESTRATOR_SLEPT_PANES_REQUEST_CHANNEL, { requestId })
  })
}

function parseSleptPanes(value: unknown): SleptPanes | null {
  if (!Array.isArray(value)) {
    return null
  }
  const panes: SleptPanes = []
  for (const entry of value) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('paneKey' in entry) ||
      !('sessionId' in entry) ||
      typeof entry.paneKey !== 'string' ||
      typeof entry.sessionId !== 'string'
    ) {
      return null
    }
    panes.push({ paneKey: entry.paneKey, sessionId: entry.sessionId })
  }
  return panes
}

function finishedWslMove(userDataPath: string, distro: string): WslMoveFinishedMove | null {
  const move = listWslMoveCutoverChain(userDataPath, wslMoveJournalKey(distro)).findLast(
    (cutover) => WSL_MOVE_CUTOVER_PHASES.indexOf(cutover.phase) >= COMMITTED_FROM
  )
  if (!move) {
    return null
  }
  const { distroGuid } = move.manifest.source
  return distroGuid
    ? { migrationId: move.migrationId, distroGuid }
    : { migrationId: move.migrationId }
}

function isHostReady(distro: string): boolean {
  const key = wslMoveJournalKey(distro)
  return (
    getWslHostService()
      ?.getStatuses()
      .some((status) => wslMoveJournalKey(status.distro) === key && status.state === 'ready') ??
    false
  )
}

function prepareHost(distro: string): Promise<WslMoveHostReadiness> {
  const service = getWslHostService()
  if (!service) {
    return Promise.resolve('failed')
  }
  const environmentId = defaultWslOrcadEnvironmentId(distro)
  return prepareWslMoveHost(
    {
      readRunningDistros: readConfirmedRunningWslDistros,
      isHostReady,
      hasHost: () => service.recordForEnvironment(environmentId) !== null,
      connect: () => service.connect(environmentId),
      add: () => service.add({ distro, startIfStopped: false })
    },
    distro
  )
}

function publish(records: WslMoveOrchestratorRecord[]): void {
  const window = getTrustedUIRendererWindow()
  if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send(WSL_MOVE_ORCHESTRATOR_STATUS_CHANNEL, records)
  }
}

function createOrchestrator(
  store: Store,
  driverDeps: () => WslMoveDriverDeps
): WslMoveOrchestrator {
  const userDataPath = app.getPath('userData')
  return new WslMoveOrchestrator({
    now: () => Date.now(),
    appVersion: app.getVersion(),
    autoMoveEnabled: () => process.env[WSL_MOVE_ORCHESTRATOR_AUTO_ENV] !== '0',
    prepareHost,
    preview: async (distro) =>
      previewWslMove(driverDeps(), {
        distro,
        sleptPanes: await requestSleptPanes()
      }),
    start: async (distro) => {
      const sleptPanes = await requestSleptPanes()
      return runTrackedWslMove(driverDeps(), (deps) =>
        moveProjectsToWslHost(deps, { distro, sleptPanes })
      )
    },
    finishedMove: (distro) => finishedWslMove(userDataPath, distro),
    checkMovedDistro: async (distro, move) =>
      wslMovedDistroVerdict(await readWslDistroRegistrations(), distro, move.distroGuid),
    releaseFinishedMove: async (distro, unsavedWorkspaceIds) => {
      const move = listWslMoveCutoverChain(userDataPath, wslMoveJournalKey(distro)).at(-1)
      const repoId = move?.manifest.source.scopeRepoIds[0]
      const folderWorkspaceId = move?.manifest.source.scopeFolderWorkspaceIds[0]
      const ref = repoId ? { repoId } : folderWorkspaceId ? { folderWorkspaceId } : null
      return ref
        ? releaseWslMovedProjectHere(userDataPath, ref, unsavedWorkspaceIds, () =>
            createWslMoveUndoPorts(store, userDataPath)
          )
        : { released: false, reason: 'not-moved' }
    },
    load: () => readWslMoveOrchestratorRecords(userDataPath),
    save: (records) => writeWslMoveOrchestratorRecords(userDataPath, records),
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
    track: (trigger, record, cause) =>
      trackWslMoveOrchestrator(wslMoveOrchestratorEventProps(trigger, record, cause)),
    publish
  })
}

/** T1 and T3: a host reaching ready, or already ready at start; T2 arrives from the window. */
function followHostReadiness(orchestrator: WslMoveOrchestrator): void {
  const service = getWslHostService()
  if (!service) {
    return
  }
  const ready = new Set<string>()
  const observe = (trigger: 'connect' | 'startup'): void => {
    const now = new Set<string>()
    for (const status of service.getStatuses()) {
      if (status.state !== 'ready') {
        continue
      }
      const key = wslMoveJournalKey(status.distro)
      now.add(key)
      if (!ready.has(key)) {
        void orchestrator.trigger(status.distro, trigger)
      }
    }
    ready.clear()
    for (const key of now) {
      ready.add(key)
    }
  }
  service.onStatusesChanged(() => observe('connect'))
  observe('startup')
}

let orchestrator: WslMoveOrchestrator | null = null

/** `driverDeps` is the move dialog's own factory, so both start the same driver. */
export function registerWslMoveOrchestrator(
  store: Store,
  driverDeps: () => WslMoveDriverDeps
): void {
  for (const channel of WSL_MOVE_ORCHESTRATOR_HANDLER_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
  const isMainWindow = (sender: WebContents | undefined): boolean =>
    !!sender && getTrustedUIRendererWebContents()?.id === sender.id
  ipcMain.handle('wslMoveOrchestrator:list', (): WslMoveOrchestratorRecord[] =>
    orchestrator && wslHostsGateOpen() ? orchestrator.list() : []
  )
  // T2: the window opened a bridge project of this distro; the orchestrator checks it is running.
  ipcMain.handle(
    'wslMoveOrchestrator:projectOpened',
    (event: { sender?: WebContents }, distro: unknown): void => {
      if (
        orchestrator &&
        wslHostsGateOpen() &&
        isMainWindow(event.sender) &&
        typeof distro === 'string'
      ) {
        void orchestrator.trigger(distro, 'project-opened')
      }
    }
  )
  ipcMain.handle(
    'wslMoveOrchestrator:userAction',
    async (event: { sender?: WebContents }, request: unknown) => {
      if (
        !orchestrator ||
        !wslHostsGateOpen() ||
        !isMainWindow(event.sender) ||
        typeof request !== 'object' ||
        request === null ||
        !('distro' in request) ||
        !('action' in request) ||
        typeof request.distro !== 'string'
      ) {
        return null
      }
      const action = USER_ACTIONS.find((candidate) => candidate === request.action)
      if (!action) {
        return null
      }
      const unsaved =
        'unsavedWorkspaceIds' in request && Array.isArray(request.unsavedWorkspaceIds)
          ? request.unsavedWorkspaceIds.filter((id): id is string => typeof id === 'string')
          : []
      return orchestrator.userAction(request.distro, action, { unsavedWorkspaceIds: unsaved })
    }
  )
  ipcMain.handle(
    'wslMoveOrchestrator:answerSleptPanes',
    (event: { sender?: WebContents }, request: unknown): void => {
      if (
        !isMainWindow(event.sender) ||
        typeof request !== 'object' ||
        request === null ||
        !('requestId' in request) ||
        typeof request.requestId !== 'string' ||
        !('sleptPanes' in request)
      ) {
        return
      }
      sleptPaneRequests.get(request.requestId)?.(parseSleptPanes(request.sleptPanes))
    }
  )
  // Dark: nothing is constructed or read while the gate is closed.
  if (!wslHostsGateOpen() || !getWslHostService() || orchestrator) {
    return
  }
  orchestrator = createOrchestrator(store, driverDeps)
  followHostReadiness(orchestrator)
}
