import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from './managed-account-types'

export type HostAccountSignInProvider = 'claude' | 'codex'

export type HostAccountSignInPhase =
  | 'starting'
  | 'waiting'
  | 'verifying'
  | 'signedIn'
  | 'failed'
  | 'cancelled'

/** What a login running on the host asks of the person on another device. */
export type HostAccountSignInPrompt = {
  /** The page to open in that device's browser. */
  url: string
  /** Codex's one-time device code, typed into that page. */
  userCode: string | null
  /** Claude shows a code after sign-in that has to come back to the host. */
  needsCode: boolean
}

/** How a login running on the host reaches the person signing in elsewhere. */
export type HostAccountSignInChannel = {
  /** Aborts the login: the person cancelled, or the flow ended. */
  signal: AbortSignal
  onPrompt: (prompt: HostAccountSignInPrompt) => void
  /** The code the person pasted back; rejects if the flow ends first. */
  nextCode: () => Promise<string>
}

/** One sign-in as the host reports it to the client that started it. */
export type HostAccountSignInStatus = {
  flowId: string
  provider: HostAccountSignInProvider
  revision: number
  phase: HostAccountSignInPhase
  prompt?: HostAccountSignInPrompt
  error?: string
  claude?: ClaudeRateLimitAccountsState
  codex?: CodexRateLimitAccountsState
}

export const HOST_ACCOUNT_SIGN_IN_SETTLED_PHASES: ReadonlySet<HostAccountSignInPhase> = new Set([
  'signedIn',
  'failed',
  'cancelled'
])
