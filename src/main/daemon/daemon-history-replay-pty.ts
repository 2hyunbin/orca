import { release } from 'node:os'
import { resolvePtyOwnerBackend } from '../../shared/pty-owner-backend'
import { windowsPtyForOwnerBackend } from '../../shared/xterm-conpty-options'
import type { SessionMeta } from './terminal-history-metadata'

/**
 * Stamped into a session's meta by a daemon whose live emulator resizes like ConPTY
 * (resizeLikeOwnPty). Daemons outlive app updates, so a log without it came from an older one.
 */
export const DAEMON_HISTORY_RESIZE_MODEL = 'conpty-viewport-v1'

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

/** A saved log replays with the model of the daemon that wrote it; an older one's is xterm's. */
export function historyLogReplayWindowsPty(
  meta: Pick<SessionMeta, 'resizeModel'>
): ReturnType<typeof windowsPtyForOwnerBackend> {
  return meta.resizeModel === DAEMON_HISTORY_RESIZE_MODEL
    ? daemonHistoryReplayWindowsPty()
    : undefined
}
