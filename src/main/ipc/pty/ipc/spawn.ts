import type { IpcMainInvokeEvent } from 'electron'
import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { isAdmittedRendererPage } from '../delivery/renderer-page'
import {
  openRendererAttachment,
  type RendererAttachmentBinding
} from '../delivery/renderer-attachments'
import type { PtyRendererDelivery } from '../session'

/** The open page's connection opens its record here, before the provider can emit. */
export function openSpawnRendererAttachment(
  event: IpcMainInvokeEvent,
  args: PtySpawnIpcArgs,
  mainWindow: PtyRendererDelivery | undefined
): RendererAttachmentBinding | null {
  const attachment = args.rendererAttachment
  if (
    !attachment ||
    typeof attachment.key !== 'string' ||
    !isAdmittedRendererPage(event, mainWindow, attachment.page)
  ) {
    return null
  }
  return openRendererAttachment(attachment.page, attachment.key, null, {
    consuming: attachment.consuming === true,
    visible: attachment.visible === true
  })
}

function readSpawnReplyId(reply: unknown): string | null {
  return typeof reply === 'object' &&
    reply !== null &&
    'id' in reply &&
    typeof reply.id === 'string'
    ? reply.id
    : null
}

export function installPtySpawnIpcHandler(deps: PtySpawnIpcDeps): void {
  const ipcMain = getPtyIpc()
  const { getLocalPtyStartupPromise } = deps

  ipcMain.handle('pty:spawn', async (event, args: PtySpawnIpcArgs) => {
    // Why before any await: the connection's later reports must find its record.
    const attachment = deps.openSpawnRendererAttachment?.(event, args) ?? null
    try {
      const startupPromise = getLocalPtyStartupPromise(
        getConnectionExecutionHostId(args.connectionId)
      )
      if (startupPromise) {
        await startupPromise
      }
      const reply = await runPtyIpcSpawn(deps, args, attachment)
      // Why: joined and adopted replies bind here; every reply's id reconciles a renamed one.
      const replyId = readSpawnReplyId(reply)
      if (replyId !== null) {
        attachment?.bind(replyId)
      }
      return reply
    } catch (error) {
      attachment?.release()
      throw error
    }
  })
}
