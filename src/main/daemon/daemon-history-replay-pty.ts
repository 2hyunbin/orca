import { release } from 'node:os'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { windowsPtyForOwnerBackend } from '../../shared/xterm-conpty-options'

/**
 * The resize model to replay this daemon's terminal history with: the live emulator's. Every
 * session a Windows daemon records is ConPTY, WSL shells included, so a replay of its saved output
 * must move rows through a resize as the live screen did, or the two disagree by the rows moved.
 */
export function daemonHistoryReplayWindowsPty(): ReturnType<typeof windowsPtyForOwnerBackend> {
  return windowsPtyForOwnerBackend(
    resolvePtyOwnerBackend({ platform: process.platform, shellPath: undefined }),
    release()
  )
}
