export type CloseStartupQueryAuthorityRequest = {
  id: string
  type: 'closeStartupQueryAuthority'
  payload: { sessionId: string }
}

/** Daemon-wide viewer colours every session answers OSC 10/11 from (v38+). */
export type SetColorQueryReplyColorsRequest = {
  id: string
  type: 'setColorQueryReplyColors'
  payload: { colors: unknown }
}

/** The daemon's own answer about one chat → terminal switch generation; an unseen one is fenced. */
export type ObserveTerminalSwitchRequest = {
  id: string
  type: 'observeTerminalSwitch'
  payload: { generation: string; fence?: boolean }
}
