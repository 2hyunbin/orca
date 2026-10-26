/** What the move orchestrator (D3a) reads and drives, so tests and production share one shape. */
import type { WslMovePreview, WslMoveResult } from '../../../shared/wsl-move/wsl-move-driver-types'
import type { WslMoveUseLocallyResult } from '../../../shared/wsl-move/wsl-moved-project'
import type {
  WslMoveOrchestratorRecord,
  WslMoveOrchestratorTrigger
} from '../../../shared/wsl-move/wsl-move-orchestrator-types'
import type { WslMovedDistroVerdict } from './wsl-move-orchestrator-transitions'

export type WslMoveHostReadiness = 'ready' | 'not-running' | 'unverifiable' | 'failed'

/** The newest finished move of a distro, as R38's check needs it. */
export type WslMoveFinishedMove = { migrationId: string; distroGuid?: string }

export type WslMoveOrchestratorPorts = {
  now: () => number
  appVersion: string
  /** Kill switches for automatic starts (env, rollout); explicit user actions still run. */
  autoMoveEnabled: () => boolean
  /**
   * Readies the distro's host for an automatic step, only if the distro is confirmed running:
   * connects or adds its host then, and never boots it (A1). A failed running-distro read is
   * `unverifiable`, never `not-running`: losing contact is no evidence either way.
   */
  prepareHost: (distro: string) => Promise<WslMoveHostReadiness>
  /** E11: the user's Remove of the distro's host has not proven its server stopped. */
  hostRemovalPending: (distro: string) => boolean
  /** Whether the distro's host connection is ready now; never connects. Gates timer steps. */
  isHostReady: (distro: string) => boolean
  preview: (distro: string) => Promise<WslMovePreview>
  start: (distro: string) => Promise<WslMoveResult>
  finishedMove: (distro: string) => WslMoveFinishedMove | null
  /** R38: reads the registry and, when ready, the host's catalog; never boots the distro. */
  checkMovedDistro: (distro: string, move: WslMoveFinishedMove) => Promise<WslMovedDistroVerdict>
  /**
   * R38 restore, step one: drop every finished move of the distro, newest first, so its retained
   * rows can move again. The window reloads after a release; the move waits for the next trigger.
   */
  releaseFinishedMove: (
    distro: string,
    unsavedWorkspaceIds: readonly string[]
  ) => Promise<WslMoveUseLocallyResult>
  load: () => Map<string, WslMoveOrchestratorRecord>
  save: (records: ReadonlyMap<string, WslMoveOrchestratorRecord>) => void
  /** Returns the cancel. */
  schedule: (delayMs: number, run: () => void) => () => void
  /** One row per state change; `cause` is the preview or result behind it. */
  track: (
    trigger: WslMoveOrchestratorTrigger,
    record: WslMoveOrchestratorRecord,
    cause?: WslMovePreview | WslMoveResult
  ) => void
  publish: (records: WslMoveOrchestratorRecord[]) => void
}
