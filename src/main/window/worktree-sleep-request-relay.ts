import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  WorktreeSleepRequest,
  WorktreeSleepResponse
} from '../../shared/worktree-sleep-request'

// Why longer than a tab close: one request sleeps every workspace of a project in turn.
const WORKTREE_SLEEP_TIMEOUT_MS = 60_000

export type WorktreeSleepResult = { failedWorktreeIds: string[] }

/** The parts of a BrowserWindow the relay touches. */
export type WorktreeSleepRendererWindow = {
  isDestroyed(): boolean
  readonly webContents: {
    isDestroyed(): boolean
    send(channel: string, request: WorktreeSleepRequest): void
    once(event: 'destroyed', listener: () => void): unknown
    once(event: 'render-process-gone', listener: () => void): unknown
    removeListener(event: 'destroyed', listener: () => void): unknown
    removeListener(event: 'render-process-gone', listener: () => void): unknown
  }
  once(event: 'closed', listener: () => void): unknown
  removeListener(event: 'closed', listener: () => void): unknown
}

// Why: no call site passes a real window yet; keep the narrow type honest against Electron's.
const browserWindowFits: BrowserWindow extends WorktreeSleepRendererWindow ? true : never = true
void browserWindowFits

/**
 * Sleep runs in the renderer, which owns the slept-pane records; this waits until it has slept
 * the workspaces and persisted their session. Rejects `renderer_unavailable` or
 * `worktree_sleep_timeout`; there is no headless fallback.
 */
export async function requestWorktreeSleepFromRenderer(
  mainWindow: WorktreeSleepRendererWindow,
  worktreeIds: readonly string[]
): Promise<WorktreeSleepResult> {
  if (mainWindow.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const webContents = mainWindow.webContents
  if (webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const requestId = randomUUID()
  return new Promise<WorktreeSleepResult>((resolve, reject) => {
    let settled = false
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const finish = (outcome: Error | WorktreeSleepResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener('ui:worktreeSleepResponse', onResponse)
      mainWindow.removeListener('closed', onRendererUnavailable)
      webContents.removeListener('destroyed', onRendererUnavailable)
      webContents.removeListener('render-process-gone', onRendererUnavailable)
      if (outcome instanceof Error) {
        reject(outcome)
      } else {
        resolve(outcome)
      }
    }
    const timeout = setTimeout(
      () => finish(new Error('worktree_sleep_timeout')),
      WORKTREE_SLEEP_TIMEOUT_MS
    )
    const onResponse = (event: Electron.IpcMainEvent, response: WorktreeSleepResponse): void => {
      // Why: request ids are visible to renderer code; only the selected window may answer.
      if (event.sender !== webContents || response.requestId !== requestId) {
        return
      }
      finish(
        response.error
          ? new Error(response.error)
          : { failedWorktreeIds: response.failedWorktreeIds ?? [] }
      )
    }
    ipcMain.on('ui:worktreeSleepResponse', onResponse)
    mainWindow.once('closed', onRendererUnavailable)
    webContents.once('destroyed', onRendererUnavailable)
    webContents.once('render-process-gone', onRendererUnavailable)
    const request: WorktreeSleepRequest = { requestId, worktreeIds: [...worktreeIds] }
    try {
      webContents.send('ui:worktreeSleepRequest', request)
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
