import { app, ipcMain, type BrowserWindow } from 'electron'
import {
  createRejectedNativeFileDropPayload,
  validateNativeFileDropPaths
} from '../../shared/native-file-drop'
import { AGENT_SESSION_ATTACHMENT_MAX_BYTES } from '../../shared/agent-session-attachments'
import type {
  PrepareDroppedPathsRequest,
  PreparedDroppedPaths,
  StoreDroppedFileBytesRequest,
  EndDroppedFileIntakeRequest
} from '../../shared/native-file-drop-preparation'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { getDragTempCopyRoot } from './dragged-temp-file-copy'
import {
  createDroppedFileBytesIntake,
  endDroppedFileIntake,
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
    if (
      isWindowGone() ||
      event.sender !== mainWebContents ||
      event.senderFrame !== mainWebContents.mainFrame
    ) {
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
  const endHandler = (event: Electron.IpcMainInvokeEvent, args: unknown): void => {
    assertOwningWindow(event)
    if (!isEndDroppedFileIntakeRequest(args)) {
      throw new Error('Invalid dropped file intake end')
    }
    endDroppedFileIntake(deps, windowDragTempCopyLane, args)
  }
  ipcMain.removeHandler(END_CHANNEL)
  ipcMain.handle(END_CHANNEL, endHandler)
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
      ipcMain.removeHandler(END_CHANNEL)
      activePrepareHandler = undefined
    }
  })
}

const PREPARE_CHANNEL = 'fs:prepareDroppedPaths'
const STORE_BYTES_CHANNEL = 'fs:storeDroppedFileBytes'
const END_CHANNEL = 'fs:endDroppedFileIntake'
let activePrepareHandler: unknown

function isStoreDroppedFileBytesRequest(value: unknown): value is StoreDroppedFileBytesRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'intakeId' in value &&
    validIntakeId(value.intakeId) &&
    'sourceIndex' in value &&
    typeof value.sourceIndex === 'number' &&
    Number.isSafeInteger(value.sourceIndex) &&
    value.sourceIndex >= 0 &&
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
    (!('intakeId' in value) || validIntakeId(value.intakeId)) &&
    'consumer' in value &&
    (value.consumer === 'agent' ||
      value.consumer === 'main-reader' ||
      value.consumer === 'local-chat') &&
    'paths' in value &&
    Array.isArray(value.paths) &&
    value.paths.every((path: unknown) => typeof path === 'string')
  )
}

function validIntakeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
}
function isEndDroppedFileIntakeRequest(value: unknown): value is EndDroppedFileIntakeRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    'intakeId' in value &&
    validIntakeId(value.intakeId) &&
    'disposition' in value &&
    (value.disposition === 'complete' || value.disposition === 'abort')
  )
}
