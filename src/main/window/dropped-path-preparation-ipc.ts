import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  createRejectedNativeFileDropPayload,
  validateNativeFileDropPaths
} from '../../shared/native-file-drop'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths,
  StoreDroppedFileBytesRequest
} from '../../shared/native-file-drop-preparation'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { getDragTempCopyRoot } from './dragged-temp-file-copy'
import {
  createDroppedFileBytesIntake,
  createDroppedPathPreparationQueue,
  windowDragTempCopyLane,
  type DroppedPathPreparationDeps
} from './dropped-path-preparation'
import { getDarwinUserTempDir } from './darwin-user-temp-dir'

export function registerDroppedPathPreparation(
  mainWindow: BrowserWindow,
  localChatAttachmentStore?: DroppedPathPreparationDeps['localChatAttachmentStore']
): void {
  const mainWebContents = mainWindow.webContents
  const isWindowGone = (): boolean => mainWindow.isDestroyed() || mainWebContents.isDestroyed()
  const deps: DroppedPathPreparationDeps = {
    platform: process.platform,
    localChatAttachmentStore,
    getCopyEnvironment: async () => ({
      platform: process.platform,
      sourceTempRoot: await getDarwinUserTempDir(),
      copyRoot: getDragTempCopyRoot(app.getPath('temp'))
    }),
    watchRenderer: () => abortWhenRendererGone(mainWebContents)
  }
  const prepare = createDroppedPathPreparationQueue(deps, windowDragTempCopyLane)
  const storeBytes = createDroppedFileBytesIntake(deps, windowDragTempCopyLane)
  const assertOwningWindow = (event: Electron.IpcMainInvokeEvent): void => {
    if (isWindowGone() || event.sender !== mainWebContents) {
      throw new Error('Dropped paths must come from the owning window')
    }
  }
  const prepareHandler = (
    event: Electron.IpcMainInvokeEvent,
    args: unknown
  ): Promise<PreparedDroppedPaths> => {
    assertOwningWindow(event)
    if (!isPrepareDroppedPathsRequest(args)) {
      throw new Error('Invalid dropped paths request')
    }
    const validation = validateNativeFileDropPaths(args.paths)
    if (validation.status === 'rejected') {
      return Promise.resolve({
        paths: [],
        failures: [createRejectedNativeFileDropPayload(validation)]
      })
    }
    return Promise.resolve(prepare(args))
  }
  const storeBytesHandler = (
    event: Electron.IpcMainInvokeEvent,
    args: unknown
  ): Promise<PreparedDroppedPaths> => {
    assertOwningWindow(event)
    if (!isStoreDroppedFileBytesRequest(args)) {
      throw new Error('Invalid dropped file bytes')
    }
    return Promise.resolve(storeBytes(args))
  }
  ipcMain.removeHandler(PREPARE_CHANNEL)
  ipcMain.removeHandler(STORE_BYTES_CHANNEL)
  ipcMain.handle(PREPARE_CHANNEL, prepareHandler)
  ipcMain.handle(STORE_BYTES_CHANNEL, storeBytesHandler)
  activePrepareHandler = prepareHandler
  mainWindow.on('closed', () => {
    // Why: an old window closing late must not remove the replacement window's handlers.
    if (activePrepareHandler === prepareHandler) {
      ipcMain.removeHandler(PREPARE_CHANNEL)
      ipcMain.removeHandler(STORE_BYTES_CHANNEL)
      activePrepareHandler = undefined
    }
  })
}

const PREPARE_CHANNEL = 'fs:prepareDroppedPaths'
const STORE_BYTES_CHANNEL = 'fs:storeDroppedFileBytes'
let activePrepareHandler: unknown

function isStoreDroppedFileBytesRequest(value: unknown): value is StoreDroppedFileBytesRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    value.name.length > 0 &&
    'bytes' in value &&
    value.bytes instanceof Uint8Array &&
    value.bytes.byteLength <= AGENT_SESSION_ATTACHMENT_MAX_BYTES
  )
}

function isPrepareDroppedPathsRequest(value: unknown): value is PrepareDroppedPathsRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'consumer' in value &&
    (value.consumer === 'agent' ||
      value.consumer === 'main-reader' ||
      value.consumer === 'local-chat') &&
    'paths' in value &&
    Array.isArray(value.paths) &&
    value.paths.every((path: unknown) => typeof path === 'string')
  )
}
