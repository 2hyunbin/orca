// Codex's error cell once reconnect gives up for good; the TUI stays alive (tui/src/chatwidget/reconnect.rs reconnect_failed).
const CODEX_RECONNECT_FAILED_BANNER = '■ Automatic reconnect could not restore this session.'

export const CODEX_RECONNECT_FAILED_REASON =
  'Codex lost its app-server and could not reconnect; relaunch Codex to continue'

/** The alternate screen paints by cursor moves, so the banner can land mid-line or straddle chunks. */
export function codexReconnectFailedBannerArrived(
  previousText: string,
  appendedText: string
): boolean {
  return `${previousText.slice(1 - CODEX_RECONNECT_FAILED_BANNER.length)}${appendedText}`.includes(
    CODEX_RECONNECT_FAILED_BANNER
  )
}
