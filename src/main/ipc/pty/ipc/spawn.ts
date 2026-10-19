import type { IpcMainInvokeEvent } from 'electron'
import { getPtyIpc } from '../../pty-host-bindings'
import { runPtyIpcSpawn } from './spawn-run'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'
import { getConnectionExecutionHostId } from '../../../../shared/execution-host'
import { isMainWindowPtyIpcEvent } from './write-input'
import { admitRendererDocument } from '../delivery/renderer-document'
import { openSpawnConsumerClaim, type SpawnConsumerClaim } from '../delivery/spawn-consumer-claims'
import type { PtyRendererDelivery } from '../session'

/** Only the main window's live document may promise a visible consumer for its spawn. */
export function openWindowSpawnConsumerClaim(
  event: IpcMainInvokeEvent,
  args: PtySpawnIpcArgs,
  mainWindow: PtyRendererDelivery | undefined
): SpawnConsumerClaim | null {
  if (
    typeof args.consumerClaimToken !== 'number' ||
    !isMainWindowPtyIpcEvent(event, mainWindow) ||
    !admitRendererDocument(args.rendererDocumentId)
  ) {
    return null
  }
  return openSpawnConsumerClaim(args.rendererDocumentId, args.consumerClaimToken)
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
    // Why before any await: a settle sent after this request must find the record.
    const claim = deps.openSpawnConsumerClaim?.(event, args) ?? null
    try {
      const startupPromise = getLocalPtyStartupPromise(
        getConnectionExecutionHostId(args.connectionId)
      )
      if (startupPromise) {
        await startupPromise
      }
      const reply = await runPtyIpcSpawn(deps, args, claim)
      // Why: joined and adopted replies bind here; every reply's id reconciles a renamed one.
      const replyId = readSpawnReplyId(reply)
      if (replyId !== null) {
        claim?.bind(replyId)
      }
      return reply
    } catch (error) {
      claim?.release()
      throw error
    }
  })
}
